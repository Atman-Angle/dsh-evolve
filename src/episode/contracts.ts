/**
 * Episode contracts (v0.2, spec §7.1).
 *
 * Episodes are the minimal unit of experience mining: a task-level slice of a
 * session's normalized event stream. The extractor never hands a whole session
 * to a miner — it first splits into episodes so that corrections, errors, and
 * successful procedures can be attributed to a concrete task segment.
 *
 * @module dsh-evolve/episode/contracts
 */

import type { CollectorEvent } from '../contracts/trajectory.js'

export type EpisodeOutcome = 'success' | 'failure' | 'incomplete'

/** A user message that arrived after tool failures — a correction signal. */
export interface CorrectionSignal {
  /** Index into the episode's own event array. */
  index: number
  /** Turn that owns the correcting user message. */
  turn: number
  /** Whether at least one failed tool result preceded this correction. */
  afterFailure: boolean
  /** Number of failed tool results observed before this correction. */
  failuresBefore: number
}

/** A task-level slice of a session's normalized event stream. */
export interface Episode {
  id: string
  sessionId: string
  /** Indices into the *session* event array (for replay attribution). */
  startIndex: number
  endIndex: number
  /** The sliced events (episode-local indexing). */
  events: CollectorEvent[]
  /** Distinct turns that produced events in this episode. */
  turns: number[]
  toolCalls: number
  failures: number
  corrections: CorrectionSignal[]
  userInterventions: number
  outcome: EpisodeOutcome
}
