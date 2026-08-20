/**
 * Q2 support: assess intervention recovery from a treatment run's durable
 * evidence. Recovery is defined deterministically: after an injection, the
 * trajectory must either succeed, or show visible progress (a novel
 * observation or a successful mutation) within a small step window.
 *
 * Pure functions over session events + intervention records — no IO, so the
 * runtime and offline paths share one definition.
 *
 * @module dsh-evolve/offline/eval/recovery
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InterventionRecord } from '../../contracts/intervention.js'
import { FeatureExtractor, DEFAULT_MUTATION_TOOLS } from '../../features/feature-extractor.js'
import { normalizeSessionEvent } from '../../collector/trajectory-collector.js'

export interface RecoveryAssessment {
  injections: number
  recovered: number
  falsePositives: number
}

/**
 * Assess one run.
 * @param events - the run's durable session events, in log order.
 * @param records - intervention records persisted by the runtime plugin
 *   (only `injected: true` records count as interventions).
 * @param success - whether the run passed the external grader.
 * @param windowSteps - steps after an injection allowed to show progress.
 * @returns injection/recovery/false-positive counts.
 */
export function assessRecovery(
  events: readonly SessionEvent[],
  records: readonly InterventionRecord[],
  success: boolean,
  windowSteps = 3,
): RecoveryAssessment {
  const injections = records.filter(record => record.injected)
  if (injections.length === 0) {
    return { injections: 0, recovered: 0, falsePositives: 0 }
  }

  // Fold per-step novelty/mutation progress exactly like the detector does.
  const extractor = new FeatureExtractor({
    windowSize: 6,
    mutationTools: DEFAULT_MUTATION_TOOLS,
    maxNovelWindow: 12,
  })
  /** global step -> whether that step showed progress (novelty or mutation) */
  const progressByStep = new Map<number, boolean>()
  let globalStep = 0
  for (const event of events) {
    const normalized = normalizeSessionEvent(event)
    if (normalized === null) continue
    if (normalized.type === 'step/end') globalStep += 1
    extractor.feed(normalized)
    if (normalized.type === 'step/end') {
      const outcome = extractor.lastOutcome()
      progressByStep.set(globalStep, outcome !== undefined
        && (outcome.novelCount > 0 || outcome.mutationOk))
    }
  }

  let recovered = 0
  let falsePositives = 0
  for (const record of injections) {
    // The record carries the turn-local step; recovery looks at the following
    // steps by global order. Records arrive in session order, so steps after
    // this injection are exactly the ones with a larger record sequence.
    const progress = hasProgressAfter(record.step, globalStep, progressByStep, windowSteps)
    if (success || progress) {
      recovered += 1
    } else {
      falsePositives += 1
    }
  }
  return { injections: injections.length, recovered, falsePositives }
}

function hasProgressAfter(
  step: number,
  totalSteps: number,
  progressByStep: ReadonlyMap<number, boolean>,
  windowSteps: number,
): boolean {
  for (let candidate = step + 1; candidate <= Math.min(step + windowSteps, totalSteps); candidate++) {
    if (progressByStep.get(candidate) === true) return true
  }
  return false
}