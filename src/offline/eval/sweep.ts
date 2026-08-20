/**
 * Q1 support: parameter sweep over stored trajectories. For each detector
 * configuration in a grid, replay every session and measure how well "fired
 * at least once" predicts a bad outcome (turn/end error / blocked /
 * max-tokens / aborted), reporting precision / recall / false-positive rate.
 *
 * This answers WHERE a policy would fire across a trajectory corpus, never
 * whether firing helps — the online eval owns that question.
 *
 * @module dsh-evolve/offline/eval/sweep
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DetectorConfig, PolicyRecipe } from '../../contracts/recipe.js'
import { StuckDetector } from '../../detector/stuck-detector.js'
import { normalizeSessionEvent } from '../../collector/trajectory-collector.js'

/** The positive label: the run ended in a bad outcome. */
export function isBadOutcome(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const kind = event.data.reason.kind
    if (kind === 'completed' || kind === 'interrupted') return false
    return true
  }
  return false
}

export interface SweepPoint {
  /** The overridden detector fields that define this grid point. */
  triggerScore: number
  /** Detector config evaluated at this point. */
  detector: DetectorConfig
  truePositives: number
  falsePositives: number
  falseNegatives: number
  trueNegatives: number
  precision: number
  recall: number
  falsePositiveRate: number
}

export interface SweepResult {
  sessions: number
  badRuns: number
  points: SweepPoint[]
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

/** Does the detector fire at least once over one session's events? */
export function firesOnce(detector: DetectorConfig, events: readonly SessionEvent[]): boolean {
  const det = new StuckDetector(detector)
  for (const event of events) {
    const normalized = normalizeSessionEvent(event)
    if (normalized === null) continue
    det.feed(normalized)
    if (normalized.type === 'step/end') {
      const evaluation = det.evaluateLastStep()
      if (evaluation !== null && evaluation.fired) return true
    }
  }
  return false
}

/**
 * Sweep a trigger-score grid over a corpus of stored sessions.
 * @param sessions - session id → events.
 * @param scores - ascending trigger scores to evaluate.
 * @param baseDetector - detector template; each point overrides triggerScore.
 */
export function sweepTriggerScores(
  sessions: ReadonlyMap<string, readonly SessionEvent[]>,
  scores: readonly number[],
  baseDetector: DetectorConfig,
): SweepResult {
  const entries = [...sessions.entries()]
  const bad = new Map(entries.map(([id, events]) => [id, isBadOutcome(events)]))
  const badRuns = entries.filter(([, events]) => isBadOutcome(events)).length

  const points: SweepPoint[] = scores.map((triggerScore) => {
    const detector = { ...baseDetector, triggerScore }
    let truePositives = 0
    let falsePositives = 0
    let falseNegatives = 0
    let trueNegatives = 0
    for (const [id, events] of entries) {
      const fired = firesOnce(detector, events)
      const isBad = bad.get(id) ?? false
      if (fired && isBad) truePositives += 1
      else if (fired && !isBad) falsePositives += 1
      else if (!fired && isBad) falseNegatives += 1
      else trueNegatives += 1
    }
    return {
      triggerScore,
      detector,
      truePositives,
      falsePositives,
      falseNegatives,
      trueNegatives,
      precision: rate(truePositives, truePositives + falsePositives),
      recall: rate(truePositives, truePositives + falseNegatives),
      falsePositiveRate: rate(falsePositives, falsePositives + trueNegatives),
    }
  })

  return { sessions: entries.length, badRuns, points }
}

/** Render the sweep report (console table). */
export function renderSweep(result: SweepResult): string {
  const lines = [
    `Sessions: ${result.sessions}   Bad-outcome runs: ${result.badRuns}`,
    '',
    'trigger  precision  recall  FPR    TP  FP  FN  TN',
  ]
  for (const point of result.points) {
    lines.push(
      `${point.triggerScore.toFixed(2)}   `
      + `${point.precision.toFixed(3)}      ${point.recall.toFixed(3)}   ${point.falsePositiveRate.toFixed(3)}   `
      + `${point.truePositives}   ${point.falsePositives}   ${point.falseNegatives}   ${point.trueNegatives}`,
    )
  }
  return lines.join('\n')
}

export { isBadOutcome as classifyOutcome }