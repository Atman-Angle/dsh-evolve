/**
 * StuckScore — weighted fusion of the five deterministic signals into one
 * normalized score. Pure function of {@link StepSignals} and the recipe's
 * {@link DetectorConfig}; no state, no IO.
 *
 * score = Σ wᵢ · min(1, runᵢ / thresholdᵢ), with the repeated-action term
 * discounted when the window shows no state change (edit→test cycles are not
 * stuck).
 *
 * @module dsh-evolve/detector/stuck-score
 */

import type { DetectorConfig } from '../contracts/recipe.js'
import type { StepSignals, StuckReason, StuckSignalName } from '../contracts/signals.js'

/** Saturating normalization: 1 at or beyond the threshold, linear below. */
export function saturate(run: number, threshold: number): number {
  if (threshold <= 0) return run > 0 ? 1 : 0
  return Math.min(1, run / threshold)
}

export interface ScoreResult {
  score: number
  /** Signals whose normalized contribution is > 0. */
  reasons: StuckReason[]
  fired: boolean
  /** Per-signal normalized contributions (for debugging and reports). */
  contributions: Record<StuckSignalName, number>
}

/** Score one step against a detector config. */
export function stuckScore(signals: StepSignals, detector: DetectorConfig): ScoreResult {
  const { consecutiveFailures, repeatedActions, repeatedErrors, noNovelObservation, workspaceChange } = detector

  const failureTerm = saturate(signals.consecutiveFailures, consecutiveFailures.threshold)

  // Repeated identical calls are weak evidence when the environment changed.
  const stateChanged = signals.novelInWindow || signals.changedInWindow
  const actionDiscount = stateChanged ? 0 : repeatedActions.noveltyDiscount
  const actionTerm = saturate(signals.repeatedActionRun, repeatedActions.threshold) * (1 - actionDiscount)

  const errorTerm = saturate(signals.repeatedErrorRun, repeatedErrors.threshold)
  const novelTerm = saturate(signals.noNovelSteps, noNovelObservation.threshold)
  const changeTerm = workspaceChange.enabled
    ? saturate(signals.stepsSinceChange, workspaceChange.threshold)
    : 0

  const contributions: Record<StuckSignalName, number> = {
    'consecutive-failures': failureTerm,
    'repeated-actions': actionTerm,
    'repeated-errors': errorTerm,
    'no-novel-observation': novelTerm,
    'no-workspace-change': changeTerm,
  }

  const score = failureTerm * consecutiveFailures.weight
    + actionTerm * repeatedActions.weight
    + errorTerm * repeatedErrors.weight
    + novelTerm * noNovelObservation.weight
    + changeTerm * workspaceChange.weight

  const reasons: StuckReason[] = []
  const rawRuns: Record<StuckSignalName, number> = {
    'consecutive-failures': signals.consecutiveFailures,
    'repeated-actions': signals.repeatedActionRun,
    'repeated-errors': signals.repeatedErrorRun,
    'no-novel-observation': signals.noNovelSteps,
    'no-workspace-change': signals.stepsSinceChange,
  }
  for (const [signal, term] of Object.entries(contributions) as [StuckSignalName, number][]) {
    if (term > 0) reasons.push({ signal, count: rawRuns[signal] })
  }

  const fired = score >= detector.triggerScore
  return { score, reasons, fired, contributions }
}