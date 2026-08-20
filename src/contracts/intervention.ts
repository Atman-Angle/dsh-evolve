/**
 * Intervention evidence records. These live in dsh-evolve's own store
 * (`~/.dsh/evolve/`), never in the DSH durable session log.
 *
 * @module dsh-evolve/contracts/intervention
 */

import type { StuckReason } from './signals.js'

/** One stuck trigger, recorded whether or not an injection followed. */
export interface InterventionRecord {
  sessionId: string
  turn: number
  step: number
  /** The stuck score that fired. */
  score: number
  /** Signals that fired, with their measured counts. */
  reasons: StuckReason[]
  policyId: string
  policyVersion: string
  /** Whether the strategy-reset message was actually injected (false = caps/cooldown). */
  injected: boolean
  /** At which seam the injection was attempted: mid-turn step end, or turn-stopping. */
  seam: 'step-end' | 'turn-stopping' | 'record-only'
  /** Unix epoch milliseconds. */
  timestamp: number
}

/** Aggregate of a finished run, written once per session ends (best effort). */
export interface RunSummary {
  sessionId: string
  taskId?: string
  policyId?: string
  policyVersion?: string
  steps: number
  toolCalls: number
  inputTokens?: number
  outputTokens?: number
  durationMs: number
  stuckEvents: number
  interventions: number
  injections: number
  ended: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'unknown'
}