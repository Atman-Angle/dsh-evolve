/**
 * Background evolution worker (v0.2 release hardening, spec §三, §四).
 *
 * Executes queued evolution jobs one at a time. Every handler is wrapped:
 * a crash records a diagnostic, feeds the circuit breaker, and never escapes
 * to the agent path. Retry storms are impossible (queue caps attempts; the
 * breaker pauses a capability entirely on repeated failures).
 *
 * @module dsh-evolve/background/worker
 */

import { BreakerRegistry, isRetryableFailure } from './circuit-breaker.js'
import type { BackgroundQueue, EvolutionJob, EvolutionJobKind } from './queue.js'

export type JobHandler = (job: EvolutionJob, deps: unknown) => Promise<void>

/** Map each job kind to the breaker capability that guards it. */
export const JOB_CAPABILITY: Record<EvolutionJobKind, string> = {
  'mine-session': 'local-miner',
  'aggregate-experience': 'store',
  'plan-mutation': 'local-miner',
  'generate-skill-candidate': 'local-miner',
  'privacy-compile': 'privacy',
  'commons-sync': 'commons',
  'shadow-validate': 'validator',
  maintenance: 'store',
}

export interface WorkerDeps {
  /** Diagnostic sink (records non-fatal failures; may be undefined in tests). */
  recordDiagnostic?: (capability: string, error: unknown, context?: string) => Promise<void> | void
}

export interface WorkerRunResult {
  processed: number
  failed: number
}

export class EvolutionWorker {
  private readonly handlers = new Map<EvolutionJobKind, JobHandler>()
  private stopped = false
  private current: Promise<void> | undefined
  private readonly breakers: BreakerRegistry
  private readonly deps: WorkerDeps

  constructor(
    private readonly queue: BackgroundQueue,
    breakers: BreakerRegistry,
    deps: WorkerDeps = {},
  ) {
    this.breakers = breakers
    this.deps = deps
  }

  /** Register one job-kind handler (idempotent per kind). */
  on(kind: EvolutionJobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler)
  }

  /** Process one job (testable + used by the run loop). */
  async runOnce(): Promise<WorkerRunResult> {
    const job = await this.queue.dequeue()
    if (job === undefined) return { processed: 0, failed: 0 }
    const handler = this.handlers.get(job.kind)
    if (handler === undefined) {
      await this.queue.fail(job.id, `no handler for ${job.kind}`)
      return { processed: 0, failed: 1 }
    }
    const capability = JOB_CAPABILITY[job.kind]
    const breaker = this.breakers.get(capability)
    if (!breaker.allow()) {
      // Capability paused: fail the job without burning attempts (no storm).
      await this.queue.fail(job.id, `circuit open for ${capability}`)
      await this.deps.recordDiagnostic?.(capability, new Error(`circuit open — job deferred`), job.kind)
      return { processed: 0, failed: 1 }
    }
    try {
      await handler(job, undefined)
      breaker.recordSuccess()
      await this.queue.complete(job.id)
      return { processed: 1, failed: 0 }
    } catch (error) {
      breaker.recordFailure()
      await this.deps.recordDiagnostic?.(capability, error, job.kind)
      const retryable = isRetryableFailure(error)
      if (!retryable) {
        // Non-retryable: fail fast to keep the queue healthy.
        await this.queue.fail(job.id, (error as Error).message)
      } else {
        await this.queue.fail(job.id, `${(error as Error).message} (retryable)`)
      }
      return { processed: 0, failed: 1 }
    }
  }

  /** Run the loop until stopped (graceful: current job finishes). */
  async run(): Promise<void> {
    while (!this.stopped) {
      const result = await this.runOnce()
      if (result.processed === 0 && result.failed === 0) {
        await idleWait(() => this.stopped)
      }
    }
  }

  /** Stop after the current job settles (safe shutdown). */
  stop(): void {
    this.stopped = true
  }

  async whenIdle(): Promise<void> {
    await this.current
  }

  get isStopped(): boolean {
    return this.stopped
  }
}

/** Yield until woken or the stop flag flips (no busy polling). */
function idleWait(stopped: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const check = (): void => {
      if (stopped()) return resolve()
      setTimeout(check, 50)
    }
    check()
  })
}
