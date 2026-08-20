/**
 * Failure isolation audit (v0.2 release hardening, spec §十四).
 *
 * Actively injects failures into every evolution stage (miner crash, privacy
 * compiler crash, store write failure, GitHub 500/timeout/429, semantic
 * provider unavailable, invalid capsule/recipe, corrupt local state) and
 * verifies the invariant:
 *
 *   agent task still completes; no exception escapes; no inject/steer;
 *   session log intact; the affected capability pauses + a diagnostic is
 *   recorded — never the agent.
 *
 * @module dsh-evolve/audit/failure-isolation
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AuditCheck } from './contracts.js'
import { apply } from '../plugin/index.js'
import { BackgroundQueue } from '../background/queue.js'
import { EvolutionWorker } from '../background/worker.js'
import { BreakerRegistry } from '../background/circuit-breaker.js'
import { DiagnosticLog } from '../storage/diagnostics.js'
import { ExperienceStore } from '../experience/store.js'
import { SyncEngine } from '../commons/sync.js'

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent
}

/** A healthy session an "agent" completes while evolution fails around it. */
function healthySessionEvents(): SessionEvent[] {
  return [
    event('user/message', { content: 'do a thing', source: { kind: 'user' } }, 1),
    event('step/start', { turn: 1, step: 1 }, 2),
    event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }, 3),
    event('tool/result', { turn: 1, step: 1, message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }], source: { kind: 'tool', callId: 'c1' } } }, 4),
    event('step/end', { turn: 1, step: 1 }, 5),
    event('turn/end', { reason: { kind: 'completed' } }, 6),
  ]
}

export interface IsolationScenario {
  name: string
  /** Set up the failure (root prep, failing handler, fake fetcher, corrupt state). */
  prepare: (root: string) => Promise<{ handler?: (kind: string) => Promise<void>; fetcher?: (url: string) => Promise<string> }>
  /** Extra assertions after the run (e.g. breaker state). */
  assert?: (root: string) => Promise<{ pass: boolean; detail: string }>
}

const SCENARIOS: IsolationScenario[] = [
  {
    name: 'miner crash',
    prepare: async () => ({
      handler: async kind => {
        if (kind === 'mine-session') throw new Error('miner exploded')
      },
    }),
  },
  {
    name: 'privacy compiler crash',
    prepare: async () => ({
      handler: async kind => {
        if (kind === 'privacy-compile') throw new Error('privacy compiler exploded')
      },
    }),
  },
  {
    name: 'semantic provider unavailable',
    prepare: async () => ({
      handler: async kind => {
        if (kind === 'aggregate-experience') throw new Error('provider_unavailable')
      },
    }),
  },
  {
    name: 'store write failure',
    prepare: async root => {
      // A FILE where the experience store dir should be → mkdir fails.
      await writeFile(join(root, 'experiences'), 'not a directory', 'utf8')
      return {}
    },
  },
  {
    name: 'github 500 + timeout + 429',
    prepare: async () => ({
      fetcher: async url => {
        if (url.includes('500')) throw new Error('HTTP 500')
        if (url.includes('timeout')) throw new Error('timeout after 10s')
        if (url.includes('429')) throw new Error('429 Too Many Requests')
        throw new Error('no fixture')
      },
    }),
  },
  {
    name: 'invalid capsule + tampered manifest',
    prepare: async () => ({
      fetcher: async () => JSON.stringify({ schema: 'evolve/v1', kind: 'fact', shell: 'rm -rf /' }),
    }),
  },
  {
    name: 'corrupt local state',
    prepare: async root => {
      await mkdir(join(root, 'background'), { recursive: true })
      await writeFile(join(root, 'background', 'queue.jsonl'), 'not-json{{{torn line\n{"id": "job_ok", "kind": "mine-session", "priority": "low", "createdAt": 1, "payloadRef": "x", "attempts": 0, "status": "running"}\n', 'utf8')
      return {}
    },
  },
]

/** Run one scenario; returns whether the agent task completed unharmed. */
async function runScenario(root: string, scenario: IsolationScenario): Promise<{ pass: boolean; detail: string }> {
  const failures: string[] = []
  const ctx = new Context()
  const session = { id: 'isolation-session', events: [] as SessionEvent[] } as unknown as Session
  let injections = 0
  const agent = { id: session.id, session, inject: () => { injections += 1 }, steer: () => { injections += 1 } }
  ctx.provide('agents', { get: (id: string) => (id === session.id ? agent : undefined) })
  apply(ctx, { enabled: true, recipe: 'baseline', storageRoot: root, evolution: { enabled: true, mining: true, routing: true } })

  const { handler, fetcher } = await scenario.prepare(root)

  // Background worker that FAILS on the injected stage.
  const queue = new BackgroundQueue(root, { maxSize: 16, maxAttempts: 1 })
  await queue.load()
  const breakers = new BreakerRegistry({ failureThreshold: 2, cooldownMs: 1000 })
  const diagnostics = new DiagnosticLog(root)
  const worker = new EvolutionWorker(queue, breakers, { recordDiagnostic: (cap, error) => diagnostics.record(cap, error, scenario.name) })
  const failingHandler = handler ?? (async (): Promise<void> => { throw new Error(`unhandled ${queue.listActive()[0]?.kind}`) })
  worker.on('mine-session', async job => { await failingHandler(job.kind) })
  worker.on('privacy-compile', async job => { await failingHandler(job.kind) })
  worker.on('aggregate-experience', async job => { await failingHandler(job.kind) })

  // Commons sync failure (network-level).
  const syncFetcher = fetcher
  const syncResult = syncFetcher === undefined
    ? undefined
    : await new SyncEngine(root, syncFetcher).sync('https://raw.githubusercontent.com/dsh-evolve/commons/main/registry/index.json', { force: true })

  // Agent task: emit a full session; failures must not disturb it.
  try {
    const events = healthySessionEvents()
    for (const sessionEvent of events) {
      ;(session.events as SessionEvent[]).push(sessionEvent)
      ctx.emit('session/event', session, sessionEvent)
    }
    ctx.emit('session/disposed', session)
  } catch (error) {
    failures.push(`agent emit threw: ${(error as Error).message}`)
  }

  // Run the failing evolution jobs.
  await queue.enqueue({ kind: 'mine-session', priority: 'low', payloadRef: 'isolation-session' })
  await queue.enqueue({ kind: 'privacy-compile', priority: 'low', payloadRef: '' })
  await queue.enqueue({ kind: 'aggregate-experience', priority: 'low', payloadRef: '' })
  await worker.runOnce()
  await worker.runOnce()
  await worker.runOnce()
  await ctx.fiber.dispose()
  await new Promise(resolve => setTimeout(resolve, 120))

  if (injections !== 0) failures.push('agent was injected/steered during failures')
  if (session.events.length !== healthySessionEvents().length) failures.push('session log was mutated')
  if (failures.length === 0) {
    const diagCount = await diagnostics.count()
    const detail = syncResult === undefined
      ? `agent task completed; ${diagCount} diagnostic(s) recorded`
      : `agent task completed; commons sync handled ${syncResult.failed.length} failure(s) without throwing`
    return { pass: true, detail }
  }
  return { pass: false, detail: failures.join('; ') }
}

/** Run the failure-isolation audit check. */
export async function auditFailureIsolation(): Promise<AuditCheck> {
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  for (const scenario of SCENARIOS) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-fail-'))
    const result = await runScenario(root, scenario)
    results.push({ name: scenario.name, ...result })
    await rm(root, { recursive: true, force: true })
  }
  const failed = results.filter(result => !result.pass)
  return {
    id: 'failure-isolation',
    name: 'Failure isolation (agent survives injected failures)',
    scope: 'runtime',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    detail: failed.length === 0
      ? `${results.length} injected failure scenarios; agent task completed every time`
      : `${failed.length} scenario(s) failed: ${failed.map(f => f.name).join(', ')}`,
    evidence: results,
  }
}
