/**
 * Non-interference audit (v0.2 release hardening, spec §十一).
 *
 * Deterministic DSH fixture run three ways:
 *
 *   A. Vanilla (events as ground truth)
 *   B. DSH + dsh-evolve, observation only
 *   C. DSH + dsh-evolve, full background evolution (real queue + worker),
 *      no ACTIVE mutation
 *
 * The durable session event log IS the trajectory (model requests, tool calls,
 * names, arguments, results, turns, steps, completion are all derived from
 * it). The plugin must never mutate that log, never inject, never steer, and
 * must not change the derived trajectory: A == B == C.
 *
 * @module dsh-evolve/audit/non-interference
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AuditCheck } from './contracts.js'
import { apply } from '../plugin/index.js'
import { BackgroundQueue } from '../background/queue.js'
import { EvolutionWorker } from '../background/worker.js'
import { BreakerRegistry } from '../background/circuit-breaker.js'
import { ExperienceStore } from '../experience/store.js'
import { extractEpisodes } from '../episode/extractor.js'
import { mineEpisode } from '../experience/miner.js'
import { collectorEvents } from '../offline/analyzer.js'

interface Spy {
  count: number
  fn: () => void
}

function makeSpy(): Spy {
  const spy: Spy = { count: 0, fn: () => { spy.count += 1 } }
  return spy
}

interface Harness {
  ctx: Context
  session: Session
  inject: Spy
  steer: Spy
}

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent
}

/** Deterministic fixture: healthy task + correction-shaped task. */
export function fixtureEvents(): SessionEvent[] {
  return [
    event('user/message', { content: 'install the dependencies', source: { kind: 'user' } }, 1),
    event('step/start', { turn: 1, step: 1 }, 2),
    event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm install"}' }, 3),
    event('tool/result', { turn: 1, step: 1, message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'npm ERR! no pkg' }], isError: true }], source: { kind: 'tool', callId: 'c1' } }, error: { name: 'Error', code: 'E404' } }, 4),
    event('step/end', { turn: 1, step: 1 }, 5),
    event('user/message', { content: 'use pnpm instead', source: { kind: 'user' } }, 6),
    event('step/start', { turn: 2, step: 1 }, 7),
    event('tool/call', { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"pnpm install"}' }, 8),
    event('tool/result', { turn: 2, step: 1, message: { id: 'm2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'added 42 packages' }], isError: false }], source: { kind: 'tool', callId: 'c2' } } }, 9),
    event('step/end', { turn: 2, step: 1 }, 10),
    event('turn/end', { reason: { kind: 'completed' } }, 11),
  ]
}

export interface TrajectoryMetrics {
  eventCount: number
  toolCalls: number
  toolNames: string[]
  toolArguments: string[]
  toolResults: string[]
  turns: number[]
  steps: number
  completed: boolean
}

/** Derive the trajectory metrics from a durable session event log. */
export function trajectoryMetrics(events: readonly SessionEvent[]): TrajectoryMetrics {
  const toolCalls: string[] = []
  const toolArguments: string[] = []
  const toolResults: string[] = []
  const turns = new Set<number>()
  let steps = 0
  let completed = false
  for (const sessionEvent of events) {
    switch (sessionEvent.type) {
      case 'tool/call':
        toolCalls.push(sessionEvent.data.name)
        toolArguments.push(sessionEvent.data.arguments)
        turns.add(sessionEvent.data.turn)
        break
      case 'tool/result': {
        const first = sessionEvent.data.message.content[0] as { content?: Array<{ text?: string }> } | undefined
        toolResults.push(first?.content?.[0]?.text ?? '')
        break
      }
      case 'step/start':
        steps += 1
        break
      case 'turn/end':
        if (sessionEvent.data.reason.kind === 'completed') completed = true
        break
      default:
        break
    }
  }
  return {
    eventCount: events.length,
    toolCalls: toolCalls.length,
    toolNames: toolCalls,
    toolArguments,
    toolResults,
    turns: [...turns].sort((a, b) => a - b),
    steps,
    completed,
  }
}

function makeHarness(dir: string): Harness {
  const ctx = new Context()
  const session = { id: 'audit-ni-session', events: [] as SessionEvent[] } as unknown as Session
  const inject = makeSpy()
  const steer = makeSpy()
  ctx.provide('agents', { get: (id: string) => (id === session.id ? { id, session, inject: inject.fn, steer: steer.fn } : undefined) })
  return { ctx, session, inject, steer }
}

function emit(h: Harness, events: readonly SessionEvent[]): void {
  for (const sessionEvent of events) {
    ;(h.session.events as SessionEvent[]).push(sessionEvent)
    h.ctx.emit('session/event', h.session, sessionEvent)
  }
}

/** Run the A == B == C comparison. */
export async function runNonInterference(): Promise<{ pass: boolean; detail: string; arms: Record<string, TrajectoryMetrics> }> {
  const fixture = fixtureEvents()
  const arms: Record<string, TrajectoryMetrics> = {}
  const failures: string[] = []

  // Arm A: vanilla ground truth.
  arms['A'] = trajectoryMetrics(fixture)

  // Arm B: observation only.
  {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-ni-b-'))
    const h = makeHarness(dir)
    apply(h.ctx, { enabled: true, recipe: 'baseline', storageRoot: dir, evolution: { enabled: true, mining: true, routing: true } })
    emit(h, fixture)
    await h.ctx.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 120))
    if (h.inject.count !== 0 || h.steer.count !== 0) failures.push('arm B: observer injected/steered')
    arms['B'] = trajectoryMetrics(h.session.events)
    await rm(dir, { recursive: true, force: true })
  }

  // Arm C: full background evolution (real queue + worker), no active mutation.
  {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-ni-c-'))
    const h = makeHarness(dir)
    apply(h.ctx, { enabled: true, recipe: 'baseline', storageRoot: dir, evolution: { enabled: true, mining: true, routing: true } })
    emit(h, fixture)
    const queue = new BackgroundQueue(dir, { maxSize: 32, maxAttempts: 2 })
    await queue.load()
    const worker = new EvolutionWorker(queue, new BreakerRegistry({ failureThreshold: 3, cooldownMs: 1000 }))
    worker.on('mine-session', async job => {
      const store = new ExperienceStore(dir)
      const raw = h.session.events
      const episodes = extractEpisodes(job.payloadRef || 'audit-ni-session', collectorEvents(raw))
      const candidates = episodes.flatMap(episode => mineEpisode(episode, job.payloadRef || 'audit-ni-session'))
      await store.merge(candidates)
    })
    await queue.enqueue({ kind: 'mine-session', priority: 'low', payloadRef: 'audit-ni-session' })
    await worker.runOnce() // background mining actually runs
    h.ctx.emit('session/disposed', h.session)
    await h.ctx.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 120))
    if (h.inject.count !== 0 || h.steer.count !== 0) failures.push('arm C: observer injected/steered')
    arms['C'] = trajectoryMetrics(h.session.events)
    await rm(dir, { recursive: true, force: true })
  }

  const a = JSON.stringify(arms['A'])
  const b = JSON.stringify(arms['B'])
  const c = JSON.stringify(arms['C'])
  if (a !== b) failures.push('arm A ≠ arm B (observer changed the trajectory)')
  if (a !== c) failures.push('arm A ≠ arm C (background evolution changed the trajectory)')
  return {
    pass: failures.length === 0,
    detail: failures.length === 0
      ? `A == B == C (${arms['A']?.eventCount} events, ${arms['A']?.toolCalls} tool calls, ${arms['A']?.steps} steps, completed=${arms['A']?.completed})`
      : failures.join('; '),
    arms,
  }
}

/** Run the non-interference audit check. */
export async function auditNonInterference(): Promise<AuditCheck> {
  const result = await runNonInterference()
  return {
    id: 'non-interference',
    name: 'Non-interference (A == B == C)',
    scope: 'runtime',
    verdict: result.pass ? 'PASS' : 'FAIL',
    detail: result.detail,
    evidence: result.arms,
  }
}
