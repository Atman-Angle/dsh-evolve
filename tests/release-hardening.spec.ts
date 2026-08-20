/**
 * Release-hardening unit tests (v0.2 WP-A): circuit breaker, background queue,
 * worker, scheduler, permission modes/gate, network adapter + allowlist.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CircuitBreaker, BreakerRegistry, isRetryableFailure, CircuitOpenError } from '../src/background/circuit-breaker.js'
import { BackgroundQueue } from '../src/background/queue.js'
import { EvolutionWorker } from '../src/background/worker.js'
import { EvolutionScheduler, planJobs } from '../src/background/scheduler.js'
import { decideEvolutionAction } from '../src/permissions/evolution-mode.js'
import { evaluateGate, permissionSummary } from '../src/permissions/promotion-gate.js'
import { isAllowedUrl, defaultNetworkPolicy, NetworkPolicyError, parseHost } from '../src/network/allowlist.js'
import { DefaultEvolveNetworkClient } from '../src/network/client.js'
import { SessionSnapshotStore } from '../src/storage/session-snapshot.js'

/* ------------------------------------------------------------------ */

describe('circuit breaker', () => {
  it('opens after failureThreshold consecutive failures and blocks calls', () => {
    let now = 0
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => now })
    expect(breaker.allow()).toBe(true)
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.allow()).toBe(true) // 2 < 3
    breaker.recordFailure()
    expect(breaker.allow()).toBe(false) // OPEN
    expect(breaker.status.state).toBe('OPEN')
  })

  it('recovers via HALF_OPEN probe after cooldown', () => {
    let now = 0
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => now })
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.allow()).toBe(false)
    now = 101
    expect(breaker.allow()).toBe(true) // HALF_OPEN probe
    breaker.recordSuccess()
    expect(breaker.status.state).toBe('CLOSED')
    expect(breaker.allow()).toBe(true)
  })

  it('registry snapshots named capabilities and classifies retryable failures', () => {
    const registry = new BreakerRegistry({ failureThreshold: 2, cooldownMs: 100 })
    registry.get('commons').recordFailure()
    registry.get('commons').recordFailure()
    const snapshot = registry.snapshot()
    expect(snapshot['commons']?.state).toBe('OPEN')
    expect(isRetryableFailure(new Error('429 Too Many Requests'))).toBe(true)
    expect(isRetryableFailure(new Error('provider quota exceeded'))).toBe(true)
    expect(isRetryableFailure(new Error('timeout after 10s'))).toBe(true)
    expect(isRetryableFailure(new Error('invalid capsule'))).toBe(false)
    expect(() => { throw new CircuitOpenError('commons') }).toThrow(/circuit open/)
  })
})

/* ------------------------------------------------------------------ */

describe('background queue', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  async function makeQueue(maxSize = 4): Promise<BackgroundQueue> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-bq-'))
    dirs.push(dir)
    const queue = new BackgroundQueue(dir, { maxSize, maxAttempts: 2 })
    await queue.load()
    return queue
  }

  it('enqueues, dequeues highest priority first, and completes', async () => {
    const queue = await makeQueue()
    await queue.enqueue({ kind: 'mine-session', priority: 'low', payloadRef: 's1' })
    await queue.enqueue({ kind: 'plan-mutation', priority: 'normal', payloadRef: '' })
    const job = await queue.dequeue()
    expect(job?.kind).toBe('plan-mutation') // normal before low
    await queue.complete(job!.id)
    expect(queue.size).toBe(1)
  })

  it('drops the lowest-value pending job when full', async () => {
    const queue = await makeQueue(2)
    await queue.enqueue({ kind: 'mine-session', priority: 'low', payloadRef: 's1' })
    await queue.enqueue({ kind: 'privacy-compile', priority: 'low', payloadRef: '' })
    const result = await queue.enqueue({ kind: 'plan-mutation', priority: 'normal', payloadRef: '' })
    expect(result.enqueued).toBe(true)
    expect(result.dropped?.kind).toBe('privacy-compile') // lowest weight dropped
    expect(queue.size).toBe(2)
  })

  it('caps attempts and marks jobs failed terminally', async () => {
    const queue = await makeQueue()
    await queue.enqueue({ kind: 'mine-session', priority: 'low', payloadRef: 's1' })
    const job = await queue.dequeue()
    const first = await queue.fail(job!.id, 'boom')
    expect(first.retried).toBe(true)
    const again = await queue.dequeue()
    expect(again?.attempts).toBe(1)
    const second = await queue.fail(again!.id, 'boom again')
    expect(second.terminal).toBe(true)
    const terminal = await queue.listTerminal()
    expect(terminal[0]?.status).toBe('failed')
  })

  it('recovers interrupted running jobs on load (resume)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-bq-'))
    dirs.push(dir)
    const first = new BackgroundQueue(dir, { maxSize: 4, maxAttempts: 3 })
    await first.load()
    await first.enqueue({ kind: 'mine-session', priority: 'low', payloadRef: 's1' })
    await first.dequeue() // marks running; simulated crash before complete
    const second = new BackgroundQueue(dir, { maxSize: 4, maxAttempts: 3 })
    await second.load()
    expect(second.size).toBe(1) // recovered to pending
    const job = await second.dequeue()
    expect(job?.status).toBe('running')
    expect(job?.kind).toBe('mine-session')
  })
})

/* ------------------------------------------------------------------ */

describe('background worker + scheduler', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  it('worker executes handlers, records diagnostics, and never escapes crashes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-bw-'))
    dirs.push(dir)
    const queue = new BackgroundQueue(dir, { maxSize: 8, maxAttempts: 1 })
    await queue.load()
    const breakers = new BreakerRegistry({ failureThreshold: 2, cooldownMs: 100 })
    const diagnostics: string[] = []
    const worker = new EvolutionWorker(queue, breakers, {
      recordDiagnostic: async (capability, error) => { diagnostics.push(`${capability}:${(error as Error).message}`) },
    })
    worker.on('mine-session', async () => { throw new Error('miner exploded') })
    worker.on('plan-mutation', async () => undefined)
    await queue.enqueue({ kind: 'mine-session', priority: 'low', payloadRef: 's1' })
    await queue.enqueue({ kind: 'plan-mutation', priority: 'normal', payloadRef: '' })
    const first = await worker.runOnce() // plan-mutation (normal priority)
    expect(first.processed).toBe(1)
    const second = await worker.runOnce() // mine-session → throws
    expect(second.failed).toBe(1)
    expect(diagnostics.some(entry => entry.startsWith('local-miner:'))).toBe(true)
    expect(queue.size).toBe(0)
  })

  it('breaker pauses a capability without burning attempts (no retry storm)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-bw-'))
    dirs.push(dir)
    const queue = new BackgroundQueue(dir, { maxSize: 8, maxAttempts: 3 })
    await queue.load()
    const breakers = new BreakerRegistry({ failureThreshold: 1, cooldownMs: 100_000 })
    const worker = new EvolutionWorker(queue, breakers)
    worker.on('commons-sync', async () => { throw new Error('HTTP 500') })
    await queue.enqueue({ kind: 'commons-sync', priority: 'low', payloadRef: '' })
    await queue.enqueue({ kind: 'commons-sync', priority: 'low', payloadRef: '' })
    await worker.runOnce() // failure → breaker OPEN
    await worker.runOnce() // circuit open → job failed without handler run
    expect(breakers.get('commons').status.state).toBe('OPEN')
  })

  it('scheduler plans jobs per trigger and enqueues them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-bs-'))
    dirs.push(dir)
    const queue = new BackgroundQueue(dir, { maxSize: 16 })
    await queue.load()
    const scheduler = new EvolutionScheduler({ queue, config: { commonsSyncIntervalMs: 0 } })
    await scheduler.enqueue('session-settled', 'sess-1')
    expect(queue.listActive().map(job => job.kind)).toEqual(['mine-session'])
    const kinds = planJobs('idle', { miningOnSessionSettled: true, commonsSyncIntervalMs: 0, planOnSessionSettled: true, privacyCompileEnabled: false }, { pendingKinds: new Set() })
    expect(kinds).toContain('mine-session')
    expect(kinds).not.toContain('privacy-compile')
  })

  it('session snapshots survive a new store instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-snapshot-'))
    dirs.push(dir)
    const first = new SessionSnapshotStore(dir)
    await first.put({ sessionId: 'session-1', events: [{ type: 'turn/end', reasonKind: 'completed' }], contexts: [], success: true, truncated: false })
    const second = new SessionSnapshotStore(dir)
    const snapshot = await second.get('session-1')
    expect(snapshot?.events).toHaveLength(1)
    await second.remove('session-1')
    await expect(second.get('session-1')).resolves.toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */

describe('permission modes + promotion gate', () => {
  it('balanced mode: 0-1 auto, 2 shadow→auto, 3 ask, 4-5 ask, 6 block', () => {
    expect(decideEvolutionAction(0, 'balanced').action).toBe('auto-promote')
    expect(decideEvolutionAction(1, 'balanced').action).toBe('auto-promote')
    expect(decideEvolutionAction(2, 'balanced').action).toBe('shadow')
    expect(decideEvolutionAction(2, 'balanced', { validationPassed: true }).action).toBe('auto-promote')
    expect(decideEvolutionAction(3, 'balanced').needsUser).toBe(true)
    expect(decideEvolutionAction(5, 'balanced').needsUser).toBe(true)
    expect(decideEvolutionAction(6, 'balanced').action).toBe('block')
  })

  it('conservative: only risk 0 is automatic', () => {
    expect(decideEvolutionAction(0, 'conservative').action).toBe('auto-promote')
    expect(decideEvolutionAction(1, 'conservative').needsUser).toBe(true)
  })

  it('autopilot: 0-2 auto; 3-4 validated auto only when explicitly enabled; 6 never', () => {
    expect(decideEvolutionAction(2, 'autopilot').action).toBe('auto-promote')
    expect(decideEvolutionAction(3, 'autopilot').needsUser).toBe(true)
    expect(decideEvolutionAction(3, 'autopilot', { autopilotRisk34Enabled: true, validationPassed: true }).action).toBe('auto-promote')
    expect(decideEvolutionAction(6, 'autopilot').action).toBe('block')
  })

  it('gate blocks system-permission changes and community code in every mode', () => {
    for (const mode of ['conservative', 'balanced', 'autopilot'] as const) {
      const verdict = evaluateGate({ risk: 0, mode, touchesSystemPermission: true })
      expect(verdict.allow).toBe(false)
      expect(verdict.reason).toContain('never')
    }
    expect(evaluateGate({ risk: 1, mode: 'autopilot', involvesCommunityCode: true }).allow).toBe(false)
  })

  it('gate requires user approval for risk 3 in balanced mode', () => {
    expect(evaluateGate({ risk: 3, mode: 'balanced' }).allow).toBe(false)
    expect(evaluateGate({ risk: 3, mode: 'balanced', userApproved: true }).allow).toBe(true)
    expect(evaluateGate({ risk: 0, mode: 'balanced' }).allow).toBe(true)
  })

  it('permission summary lists the never-automatic set', () => {
    const summary = permissionSummary('balanced')
    expect(summary.autoPromote).toContain('0-2')
    expect(summary.neverAutomatic).toContain('disable approval')
  })
})

/* ------------------------------------------------------------------ */

describe('network allowlist + client', () => {
  it('only allows GitHub Commons hosts by default', () => {
    expect(isAllowedUrl('https://raw.githubusercontent.com/dsh-evolve/commons/main/registry/index.json').allowed).toBe(true)
    expect(isAllowedUrl('https://api.github.com/repos/dsh-evolve/commons').allowed).toBe(true)
    expect(isAllowedUrl('https://evil.example.com/exfil').allowed).toBe(false)
    expect(isAllowedUrl('https://raw.githubusercontent.com/...')).toBeDefined()
  })

  it('allows the configured semantic provider host', () => {
    const policy = defaultNetworkPolicy()
    policy.semanticProviderHost = 'llm.internal.example.com'
    expect(isAllowedUrl('https://llm.internal.example.com/chat', policy).allowed).toBe(true)
    expect(parseHost('https://llm.internal.example.com/chat')).toBe('llm.internal.example.com')
  })

  it('client rejects non-allowlisted URLs with a policy error', async () => {
    const client = new DefaultEvolveNetworkClient({ maxRequestsPerMinute: 1000 })
    await expect(client.fetchText('https://evil.example.com/x')).rejects.toThrow(NetworkPolicyError)
    expect(client.auditLog().length).toBe(1)
    expect(client.auditLog()[0]?.ok).toBe(false)
  })
})
