/**
 * Detector composition: feature extractor + scoring against one recipe's
 * detector config, exposed as a small stateful unit both the runtime plugin
 * and the offline analyzer drive identically.
 *
 * @module dsh-evolve/detector/stuck-detector
 */

import type { DetectorConfig } from '../contracts/recipe.js'
import type { CollectorEvent } from '../contracts/trajectory.js'
import type { StepSignals, StuckReason } from '../contracts/signals.js'
import { FeatureExtractor, DEFAULT_MUTATION_TOOLS } from '../features/feature-extractor.js'
import { stuckScore, type ScoreResult } from './stuck-score.js'

/** Result of evaluating one step. */
export interface StepEvaluation extends ScoreResult {
  signals: StepSignals
}

export class StuckDetector {
  readonly extractor: FeatureExtractor

  constructor(
    detector: DetectorConfig,
    mutationTools: readonly string[] = DEFAULT_MUTATION_TOOLS,
  ) {
    this.extractor = new FeatureExtractor({
      windowSize: detector.windowSize,
      mutationTools,
      maxNovelWindow: detector.windowSize * 2,
    })
    this.detector = detector
  }

  private readonly detector: DetectorConfig

  feed(event: CollectorEvent): void {
    this.extractor.feed(event)
  }

  /** Evaluate the last step that ended; returns null before any step ends. */
  evaluateLastStep(): StepEvaluation | null {
    const signals = this.extractor.signals()
    if (signals.step === 0) return null
    const result = stuckScore(signals, this.detector)
    return { ...result, signals }
  }

  /** Human-readable reason lines for a report, e.g. "repeated search invocation x3". */
  static describeReasons(reasons: readonly StuckReason[]): string[] {
    const labels: Record<string, string> = {
      'consecutive-failures': 'consecutive tool failures',
      'repeated-actions': 'repeated tool invocation',
      'repeated-errors': 'repeated error signature',
      'no-novel-observation': 'no novel observation',
      'no-workspace-change': 'no workspace change',
    }
    return reasons.map(reason => `${labels[reason.signal] ?? reason.signal} x${reason.count}`)
  }
}