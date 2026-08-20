/**
 * Metrics aggregation over {@link EvalRunResult}s. Pure functions — no IO.
 *
 * @module dsh-evolve/offline/eval/metrics
 */

import type { EvalRunResult, Metrics } from '../../contracts/eval.js'

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function optionalAverage(values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : average(present)
}

/** Aggregate a set of runs (one arm). */
export function aggregateMetrics(runs: readonly EvalRunResult[]): Metrics {
  const successes = runs.filter(run => run.success).length
  const stuckRuns = runs.filter(run => run.stuckEvents > 0).length
  const avgInputTokens = optionalAverage(runs.map(run => run.inputTokens))
  const avgOutputTokens = optionalAverage(runs.map(run => run.outputTokens))
  return {
    runs: runs.length,
    successRate: runs.length === 0 ? 0 : successes / runs.length,
    avgSteps: average(runs.map(run => run.steps)),
    avgToolCalls: average(runs.map(run => run.toolCalls)),
    ...avgInputTokens === undefined ? {} : { avgInputTokens },
    ...avgOutputTokens === undefined ? {} : { avgOutputTokens },
    avgDurationMs: average(runs.map(run => run.durationMs)),
    stuckRate: runs.length === 0 ? 0 : stuckRuns / runs.length,
    totalInterventions: runs.reduce((sum, run) => sum + run.interventions, 0),
    stuckRuns,
  }
}

const toPp = (value: number): number => Math.round(value * 1000) / 10

/** Compare two arms. Deltas are treatment − baseline. */
export function compareArms(baseline: readonly EvalRunResult[], treatment: readonly EvalRunResult[]): import('../../contracts/eval.js').Comparison {
  const b = aggregateMetrics(baseline)
  const t = aggregateMetrics(treatment)
  const avgInputTokensDelta = b.avgInputTokens !== undefined && t.avgInputTokens !== undefined
    ? round2(t.avgInputTokens - b.avgInputTokens)
    : undefined
  return {
    baseline: b,
    treatment: t,
    successDeltaPp: toPp(t.successRate - b.successRate),
    avgStepsDelta: round2(t.avgSteps - b.avgSteps),
    ...avgInputTokensDelta === undefined ? {} : { avgInputTokensDelta },
    avgDurationMsDelta: round2(t.avgDurationMs - b.avgDurationMs),
    stuckRateDeltaPp: toPp(t.stuckRate - b.stuckRate),
    treatmentInterventions: t.totalInterventions,
    recovered: treatment.reduce((sum, run) => sum + (run.recovered ?? 0), 0),
    falsePositives: treatment.reduce((sum, run) => sum + (run.falsePositives ?? 0), 0),
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}