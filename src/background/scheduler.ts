/**
 * Background evolution scheduler (v0.2 release hardening, spec §二, §三).
 *
 * Decides WHEN evolution work runs: turn/end, session settled, idle,
 * maintenance window, or manual. It only ENQUEUES — the worker executes —
 * so the main agent never waits on any of it. Scheduling rules are pure and
 * testable; the scheduler itself swallows all errors (fail-open).
 *
 * @module dsh-evolve/background/scheduler
 */

import type { BackgroundQueue, EvolutionJobKind } from './queue.js'

export type EvolutionTrigger = 'turn-end' | 'session-settled' | 'idle' | 'maintenance' | 'manual'

export interface SchedulerConfig {
  /** Enqueue experience mining on settled sessions. */
  miningOnSessionSettled: boolean
  /** Enqueue periodic commons sync (background only, never blocking). */
  commonsSyncIntervalMs: number
  /** Enqueue mutation planning on settled sessions (after mining). */
  planOnSessionSettled: boolean
  /** Enqueue privacy compilation for CANDIDATE/ACTIVE experiences. */
  privacyCompileEnabled: boolean
}

export const DEFAULT_SCHEDULER_CONFIG: Required<SchedulerConfig> = {
  miningOnSessionSettled: true,
  commonsSyncIntervalMs: 6 * 60 * 60 * 1000,
  planOnSessionSettled: true,
  privacyCompileEnabled: true,
}

/** Pure planning: which job kinds a trigger should enqueue (with dedupe). */
export function planJobs(
  trigger: EvolutionTrigger,
  config: SchedulerConfig,
  state: { lastCommonsSyncAt?: number; pendingKinds: ReadonlySet<EvolutionJobKind>; now?: number },
): EvolutionJobKind[] {
  const now = state.now ?? Date.now()
  const out: EvolutionJobKind[] = []
  const add = (kind: EvolutionJobKind): void => {
    if (!state.pendingKinds.has(kind)) out.push(kind)
  }
  switch (trigger) {
    case 'session-settled':
      if (config.miningOnSessionSettled) add('mine-session')
      // Mining enqueues its dependent jobs after the snapshot is processed.
      // Keeping these out of the initial batch prevents plan/compile from
      // racing ahead of experience extraction.
      break
    case 'turn-end':
      // Turn-end only feeds cheap work; heavy mining waits for settle.
      break
    case 'idle':
      if (config.miningOnSessionSettled) add('mine-session')
      add('aggregate-experience')
      // plan/privacy are chained by the miner after its input is settled.
      break
    case 'maintenance':
      add('maintenance')
      add('aggregate-experience')
      add('shadow-validate')
      break
    case 'manual':
      add('mine-session')
      add('aggregate-experience')
      add('commons-sync')
      add('shadow-validate')
      add('maintenance')
      break
  }
  // Commons sync is time-gated, not trigger-gated.
  if (trigger !== 'manual' && trigger !== 'maintenance') {
    const last = state.lastCommonsSyncAt ?? 0
    if (config.commonsSyncIntervalMs > 0 && now - last >= config.commonsSyncIntervalMs) {
      add('commons-sync')
    }
  }
  return out
}

export interface SchedulerDeps {
  queue: BackgroundQueue
  config?: Partial<SchedulerConfig>
  recordDiagnostic?: (capability: string, error: unknown, context?: string) => Promise<void> | void
}

/** Enqueues jobs for the worker, never blocking the caller. */
export class EvolutionScheduler {
  private readonly config: Required<SchedulerConfig>
  private lastCommonsSyncAt = 0

  constructor(private readonly deps: SchedulerDeps) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...deps.config }
  }

  /** Fire-and-forget enqueue for a trigger (never throws to the caller). */
  trigger(trigger: EvolutionTrigger, payloadRef = ''): void {
    void this.enqueue(trigger, payloadRef)
  }

  async enqueue(trigger: EvolutionTrigger, payloadRef = ''): Promise<void> {
    try {
      const pending = this.deps.queue.listActive()
      const pendingKinds = new Set(pending.map(job => job.kind))
      const kinds = planJobs(trigger, this.config, {
        pendingKinds,
        lastCommonsSyncAt: this.lastCommonsSyncAt,
      })
      for (const kind of kinds) {
        const result = await this.deps.queue.enqueue({
          kind,
          priority: kind === 'mine-session' || kind === 'commons-sync' ? 'low' : 'normal',
          payloadRef,
        })
        if (kind === 'commons-sync' && result.enqueued) this.lastCommonsSyncAt = Date.now()
      }
    } catch (error) {
      await this.deps.recordDiagnostic?.('scheduler', error, trigger)
    }
  }
}
