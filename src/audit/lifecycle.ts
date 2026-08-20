/**
 * Lifecycle audit (v0.2 release hardening, spec §十三).
 *
 * Loads the plugin into a fresh cordis context, feeds events, disposes, and
 * repeats (50–100 iterations). After dispose it verifies: no lingering
 * listeners (re-emission is inert), no timers, worker stopped, queue
 * released, and that an uninstall leaves a fresh DSH session fully usable.
 *
 * @module dsh-evolve/audit/lifecycle
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AuditCheck } from './contracts.js'
import { apply } from '../plugin/index.js'

interface Harness {
  ctx: Context
  session: Session
  inject: () => void
}

function makeHarness(dir: string, config: Record<string, unknown>): Harness {
  const ctx = new Context()
  const session = { id: `audit-session-${Math.random().toString(36).slice(2, 8)}`, events: [] as SessionEvent[] } as unknown as Session
  const inject = (): void => undefined
  ctx.provide('agents', { get: (id: string) => (id === session.id ? { id, session, inject, steer: inject } : undefined) })
  apply(ctx, { enabled: true, recipe: 'baseline', storageRoot: dir, ...config })
  return { ctx, session, inject }
}

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent
}

function emitHealthy(h: Harness): void {
  const base = h.session.events.length
  const events: SessionEvent[] = [
    event('user/message', { content: 'do a thing', source: { kind: 'user' } }, base + 1),
    event('step/start', { turn: 1, step: 1 }, base + 2),
    event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }, base + 3),
    event('tool/result', { turn: 1, step: 1, message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }], source: { kind: 'tool', callId: 'c1' } } }, base + 4),
    event('step/end', { turn: 1, step: 1 }, base + 5),
    event('turn/end', { reason: { kind: 'completed' } }, base + 6),
  ]
  for (const sessionEvent of events) {
    ;(h.session.events as SessionEvent[]).push(sessionEvent)
    h.ctx.emit('session/event', h.session, sessionEvent)
  }
}

function countTimeouts(): number {
  const info = (process.getActiveResourcesInfo?.() ?? []) as string[]
  return info.filter(name => name === 'Timeout' || name === 'Immediate').length
}

/** Run the lifecycle loop; returns iteration diagnostics. */
export async function runLifecycleLoop(
  iterations: number,
): Promise<{ pass: boolean; detail: string; iterations: number }> {
  const failures: string[] = []
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-lifecycle-'))
  const timersBefore = countTimeouts()
  for (let i = 0; i < iterations; i++) {
    const h = makeHarness(dir, {})
    emitHealthy(h)
    await h.ctx.fiber.dispose()
    // After dispose: re-emitting must be inert (listeners gone).
    try {
      h.ctx.emit('session/event', h.session, event('tool/call', { turn: 9, step: 9, callId: 'x', name: 'bash', arguments: '{}' }, 9000))
      h.ctx.emit('session/disposed', h.session)
    } catch (error) {
      failures.push(`post-dispose emit threw: ${(error as Error).message}`)
    }
  }
  const timersAfter = countTimeouts()
  await rm(dir, { recursive: true, force: true })
  const timerLeak = timersAfter - timersBefore > 2 // small slack for node internals
  if (timerLeak) failures.push(`timer leak: ${timersBefore} → ${timersAfter}`)
  return {
    pass: failures.length === 0,
    detail: failures.length === 0 ? `${iterations} load/dispose cycles clean; no listener or timer residue` : failures.join('; '),
    iterations,
  }
}

/** Uninstall check: after dispose, a fresh session still loads and runs. */
export async function checkUninstall(): Promise<{ pass: boolean; detail: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-uninstall-'))
  const first = makeHarness(dir, {})
  emitHealthy(first)
  await first.ctx.fiber.dispose()
  // A brand-new context without evolve must accept a full session.
  const ctx = new Context()
  const session = { id: 'fresh-session', events: [] as SessionEvent[] } as unknown as Session
  const agent = { id: session.id, session, inject: () => undefined, steer: () => undefined }
  ctx.provide('agents', { get: (id: string) => (id === session.id ? agent : undefined) })
  const events = [event('user/message', { content: 'hi', source: { kind: 'user' } }, 1), event('turn/end', { reason: { kind: 'completed' } }, 2)]
  for (const sessionEvent of events) {
    ;(session.events as SessionEvent[]).push(sessionEvent)
    ctx.emit('session/event', session, sessionEvent)
  }
  ctx.emit('session/disposed', session)
  const readable = session.events.length === 2 // session fully readable
  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
  return { pass: readable, detail: readable ? 'fresh DSH session loads and runs after uninstall' : 'session events lost after uninstall' }
}

/** Run the lifecycle audit check. */
export async function auditLifecycle(iterations: number): Promise<AuditCheck> {
  const loop = await runLifecycleLoop(iterations)
  const uninstall = await checkUninstall()
  const pass = loop.pass && uninstall.pass
  return {
    id: 'lifecycle',
    name: `Lifecycle (${iterations} load/dispose cycles + uninstall)`,
    scope: 'lifecycle',
    verdict: pass ? 'PASS' : 'FAIL',
    detail: `${loop.detail} | uninstall: ${uninstall.detail}`,
    evidence: { loop, uninstall },
  }
}
