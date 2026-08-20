import { describe, expect, it } from 'vitest'
import { aggregateMetrics, compareArms } from '../src/offline/eval/metrics.js'
import type { EvalRunResult } from '../src/contracts/eval.js'

function run(partial: Partial<EvalRunResult>): EvalRunResult {
  return {
    taskId: 't1', runId: 'r', policyId: 'baseline', success: false,
    steps: 10, toolCalls: 5, durationMs: 100, stuckEvents: 0, interventions: 0,
    ...partial,
  }
}

describe('aggregateMetrics', () => {
  it('aggregates a set of runs', () => {
    const metrics = aggregateMetrics([
      run({ success: true, steps: 10, inputTokens: 100, outputTokens: 10, durationMs: 1000, stuckEvents: 2 }),
      run({ success: false, steps: 20, inputTokens: 200, durationMs: 2000 }),
    ])
    expect(metrics.runs).toBe(2)
    expect(metrics.successRate).toBe(0.5)
    expect(metrics.avgSteps).toBe(15)
    expect(metrics.avgInputTokens).toBe(150)
    expect(metrics.avgDurationMs).toBe(1500)
    expect(metrics.stuckRate).toBe(0.5)
    expect(metrics.stuckRuns).toBe(1)
  })

  it('handles an empty set', () => {
    const metrics = aggregateMetrics([])
    expect(metrics.runs).toBe(0)
    expect(metrics.successRate).toBe(0)
    expect(metrics.avgInputTokens).toBeUndefined()
  })

  it('optionals stay undefined when no run reports tokens', () => {
    const metrics = aggregateMetrics([run({}), run({})])
    expect(metrics.avgInputTokens).toBeUndefined()
  })
})

describe('compareArms', () => {
  it('computes treatment-minus-baseline deltas', () => {
    const comparison = compareArms(
      [run({ success: true, steps: 20, durationMs: 2000, stuckEvents: 1 })],
      [run({ success: true, steps: 10, durationMs: 1000, stuckEvents: 0 })],
    )
    expect(comparison.successDeltaPp).toBe(0)
    expect(comparison.avgStepsDelta).toBe(-10)
    expect(comparison.avgDurationMsDelta).toBe(-1000)
    expect(comparison.stuckRateDeltaPp).toBe(-100)
  })

  it('records treatment interventions', () => {
    const comparison = compareArms(
      [run({})],
      [run({ interventions: 3 }), run({ interventions: 1 })],
    )
    expect(comparison.treatmentInterventions).toBe(4)
  })
})