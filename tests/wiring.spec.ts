import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { access, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin/index.js'

/** Minimal fabricated session-event shape accepted by the collector. */
function event(type: string, data: unknown, seq: number, time = 1000 + seq): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

/** A minimal live session stand-in used by the plugin (reads id + events). */
function fakeSession(id: string, events: SessionEvent[] = []): Session {
  return { id, events } as unknown as Session
}

interface Harness {
  ctx: Context
  agent: Agent & { inject: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }
  session: Session
  dir: string
}

async function makeHarness(config?: Record<string, unknown>): Promise<Harness> {
  const ctx = new Context()
  const session = fakeSession('sess-1')
  const inject = vi.fn()
  const steer = vi.fn()
  const agent = { id: session.id, session, inject, steer } as unknown as Harness['agent']
  ctx.provide('agents', { get: (id: string) => (id === session.id ? agent : undefined) })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-wiring-'))
  apply(ctx, { enabled: true, recipe: 'reset-v1', storageRoot: dir, ...config })
  return { ctx, agent, session, dir }
}

/** Drive a stuck trajectory: `n` failed steps repeating the same failing call. */
function stuckSteps(turn: number, count: number, seqBase: number): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = seqBase
  for (let step = 1; step <= count; step++) {
    out.push(event('step/start', { turn, step }, seq++))
    out.push(event('tool/call', { turn, step, callId: `c${turn}-${step}`, name: 'bash', arguments: '{"command":"node x.js"}' }, seq++))
    out.push(event('tool/result', {
      turn, step,
      message: {
        id: `m${turn}-${step}`, role: 'user', content: [{
          type: 'tool-result', toolCallId: `c${turn}-${step}`,
          content: [{ type: 'text', text: 'Error: Cannot find module "x"' }], isError: true,
        }],
        source: { kind: 'tool', callId: `c${turn}-${step}` },
      },
      error: { name: 'Error', code: 'MODULE_NOT_FOUND' },
    }, seq++))
    out.push(event('step/end', { turn, step }, seq++))
  }
  return out
}

/** Drive a productive trajectory that breaks any stuck signal. */
function productiveSteps(turn: number, count: number, seqBase: number): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = seqBase
  for (let step = 1; step <= count; step++) {
    out.push(event('step/start', { turn, step }, seq++))
    out.push(event('tool/call', { turn, step, callId: `c${turn}-${step}`, name: 'write', arguments: `{"content":"v${step}"}` }, seq++))
    out.push(event('tool/result', {
      turn, step,
      message: {
        id: `m${turn}-${step}`, role: 'user', content: [{
          type: 'tool-result', toolCallId: `c${turn}-${step}`,
          content: [{ type: 'text', text: `writing v${step}` }], isError: false,
        }],
        source: { kind: 'tool', callId: `c${turn}-${step}` },
      },
    }, seq++))
    out.push(event('step/end', { turn, step }, seq++))
  }
  return out
}

function emit(h: Harness, sessionEvents: SessionEvent[]): void {
  for (const sessionEvent of sessionEvents) {
    ;(h.session.events as SessionEvent[]).push(sessionEvent) // mirror the durable log
    h.ctx.emit('session/event', h.session, sessionEvent)
  }
}

/** Poll until a predicate holds (store writes are fire-and-forget async). */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('waitFor timed out')
}

/** Poll until a path exists (store writes are fire-and-forget). */
async function waitForPath(path: string, timeoutMs = 2000): Promise<void> {
  return waitFor(async () => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }, timeoutMs)
}

/**
 * Read the intervention records, tolerating in-flight store writes (ENOENT on
 * the dir, EPERM/ENOENT on the file mid-replace, torn JSON) by treating them
 * as "not ready yet".
 */
async function readRecords(h: Harness): Promise<{ injected: boolean; seam: string }[]> {
  try {
    const files = await readdir(join(h.dir, 'runs'))
    const recordFile = files.find(file => file.endsWith('.jsonl'))
    if (recordFile === undefined) return []
    const content = await readFile(join(h.dir, 'runs', recordFile), 'utf8')
    const lines = content.trim().split('\n')
    return lines
      .filter(line => line !== '')
      .map(line => {
        try {
          return JSON.parse(line) as { injected: boolean; seam: string }
        } catch {
          return undefined
        }
      })
      .filter((record): record is { injected: boolean; seam: string } => record !== undefined)
  } catch {
    return []
  }
}

/** Read records once the store queue has fully drained (stable across reads). */
async function stablePath(h: Harness): Promise<string | undefined> {
  let last: string | undefined
  return waitFor(async () => {
    try {
      const files = await readdir(join(h.dir, 'runs'))
      const recordFile = files.find(file => file.endsWith('.jsonl'))
      if (recordFile === undefined) return false
      const content = await readFile(join(h.dir, 'runs', recordFile), 'utf8')
      if (content === last) return true
      last = content
      await new Promise(resolve => setTimeout(resolve, 30))
      return false
    } catch {
      return false
    }
  }).then(() => last)
}

describe('dsh-evolve plugin wiring (cordis)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('baseline recipe observes and records but never injects', async () => {
    const h = await makeHarness({ recipe: 'baseline' })
    emit(h, stuckSteps(1, 6, 10))
    expect(h.agent.inject).not.toHaveBeenCalled()
    expect(h.agent.steer).not.toHaveBeenCalled()
    await stablePath(h)
    const records = await readRecords(h)
    expect(records.length).toBeGreaterThan(0)
    expect(records.every(record => record.injected === false)).toBe(true)
    await h.ctx.fiber.dispose()
  })

  it('reset-v1 injects at step-end when stuck fires', async () => {
    const h = await makeHarness()
    emit(h, stuckSteps(1, 6, 10))
    expect(h.agent.inject).toHaveBeenCalledTimes(1)
    const message = h.agent.inject.mock.calls[0]?.[0] as { source?: { plugin?: string } }
    expect(message?.source?.plugin).toBe('dsh-evolve')
    await h.ctx.fiber.dispose()
  })

  it('does not inject on a healthy trajectory', async () => {
    const h = await makeHarness()
    emit(h, productiveSteps(1, 8, 10))
    expect(h.agent.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('respects cooldownSteps (global step clock) between injections', async () => {
    const h = await makeHarness() // cooldown 5
    emit(h, stuckSteps(1, 6, 10)) // fires at global 3 -> 1 injection
    expect(h.agent.inject).toHaveBeenCalledTimes(1)
    emit(h, stuckSteps(2, 1, 1000)) // global 7, gap 4 < 5 -> suppressed
    expect(h.agent.inject).toHaveBeenCalledTimes(1)
    emit(h, stuckSteps(3, 1, 2000)) // global 8, gap 5 -> allowed
    expect(h.agent.inject).toHaveBeenCalledTimes(2)
    await h.ctx.fiber.dispose()
  })

  it('caps injections per session (maxPerSession=3) but keeps recording', async () => {
    const h = await makeHarness()
    for (const turn of [1, 2, 3, 4, 5, 6]) {
      emit(h, stuckSteps(turn, 6, turn * 1000))
    }
    expect(h.agent.inject).toHaveBeenCalledTimes(3)
    await stablePath(h)
    const records = await readRecords(h)
    const injected = records.filter(record => record.injected)
    expect(injected.length).toBe(3)
    expect(records.length).toBeGreaterThan(3) // detection continues after the cap
    await h.ctx.fiber.dispose()
  })

  it('turn-stopping after a handled step is a no-op (dedupe, no double records)', async () => {
    const h = await makeHarness()
    emit(h, stuckSteps(1, 6, 10))
    expect(h.agent.inject).toHaveBeenCalledTimes(1)
    await stablePath(h)
    const recordsBefore = (await readRecords(h)).length
    const signal = new AbortController().signal
    h.ctx.emit('agent/turn-stopping', { agent: h.agent, turn: 1, signal })
    await stablePath(h)
    expect(h.agent.steer).not.toHaveBeenCalled()
    const recordsAfter = (await readRecords(h)).length
    expect(recordsAfter).toBe(recordsBefore)
    await h.ctx.fiber.dispose()
  })

  it('writes a run summary when the session is disposed', async () => {
    const h = await makeHarness()
    emit(h, [...stuckSteps(1, 6, 10), ...productiveSteps(2, 2, 1000)])
    h.ctx.emit('session/disposed', h.session)
    const summaryPath = join(h.dir, 'runs', 'sess-1.summary.json')
    await waitForPath(summaryPath)
    const content = await readFile(summaryPath, 'utf8')
    const summary = JSON.parse(content) as { steps: number; toolCalls: number; ended: string }
    expect(summary.steps).toBe(8)
    expect(summary.toolCalls).toBe(8)
    expect(summary.ended).toBe('unknown')
    await h.ctx.fiber.dispose()
  })

  it('removes all listeners on context dispose (uninstall safety)', async () => {
    const h = await makeHarness()
    emit(h, stuckSteps(1, 6, 10))
    expect(h.agent.inject).toHaveBeenCalledTimes(1)
    await h.ctx.fiber.dispose()

    const h2 = await makeHarness()
    await h2.ctx.fiber.dispose()
    try {
      emit(h2, stuckSteps(1, 6, 10))
    } catch {
      // a disposed context may refuse emissions — either way listeners are gone
    }
    expect(h2.agent.inject).not.toHaveBeenCalled()
    expect(h2.agent.steer).not.toHaveBeenCalled()
  })
})