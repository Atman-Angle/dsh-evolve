/**
 * Deterministic stuck signals computed per agent step (v0.1).
 *
 * Every value here is derived purely from the normalized {@link CollectorEvent}
 * stream, so the runtime path (DSH session/event listeners) and the offline
 * analyzer (replay over stored sessions) produce identical numbers.
 *
 * @module dsh-evolve/contracts/signals
 */

/** The closed set of v0.1 stuck signals. */
export type StuckSignalName =
  | 'consecutive-failures'
  | 'repeated-actions'
  | 'repeated-errors'
  | 'no-novel-observation'
  | 'no-workspace-change'

/** Per-step deterministic signal values, computed at each `step/end`. */
export interface StepSignals {
  /** Absolute step number (1-based) within the session since observation start. */
  step: number
  /** Turn that owns this step. */
  turn: number
  /** A: consecutive unproductive steps (tool failures with no novelty/change), window-capped. */
  consecutiveFailures: number
  /** B: longest consecutive run of identical (tool, canonical arguments) calls in the window. */
  repeatedActionRun: number
  /** C: longest consecutive run of identical error signatures in the window. */
  repeatedErrorRun: number
  /** D: consecutive steps with no novel observation, window-capped. */
  noNovelSteps: number
  /** E: steps since the last observed workspace change (mutation success). */
  stepsSinceChange: number
  /** Whether an observation in the window was novel (not seen before in the window). */
  novelInWindow: boolean
  /** Whether a workspace change happened in the window. */
  changedInWindow: boolean
}

/** One fired signal with its measured run length, attached to a stuck trigger. */
export interface StuckReason {
  signal: StuckSignalName
  /** The raw run/count that fired — the evidence behind the trigger. */
  count: number
}