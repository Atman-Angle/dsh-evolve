import { describe, expect, it } from 'vitest'
import { buildReportData, renderReport } from '../src/offline/eval/report.js'
import { compareArms } from '../src/offline/eval/metrics.js'
import type { EvalRunResult } from '../src/contracts/eval.js'

function run(partial: Partial<EvalRunResult>): EvalRunResult {
  return {
    taskId: 't1', runId: 'r', policyId: 'baseline', success: false,
    steps: 10, toolCalls: 5, durationMs: 100, stuckEvents: 0, interventions: 0,
    ...partial,
  }
}

describe('renderReport', () => {
  it('renders the spec-shaped report with cases', () => {
    const comparison = compareArms(
      [run({ success: true, steps: 20 }), run({ success: false, steps: 22 })],
      [run({ success: true, steps: 17 }), run({ success: true, steps: 19 })],
    )
    const report = buildReportData({
      comparison,
      cases: [
        { kind: 'success', taskId: 't1', runId: 'a', note: 'reset at step 12, passed after' },
        { kind: 'false-positive', taskId: 't2', runId: 'b', note: 'would have finished naturally' },
      ],
      tasks: 2,
      baselineRuns: 2,
      treatmentRuns: 2,
      model: 'deepseek-v4-flash',
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    const text = renderReport(report)
    expect(text).toContain('# dsh-evolve experiment')
    expect(text).toContain('Dataset: 2 tasks')
    expect(text).toContain('Runs: 2 baseline / 2 treatment')
    expect(text).toContain('| Success | 50.0% | 100.0% | +50pp |')
    expect(text).toContain('Interventions:')
    expect(text).toContain('## 案例（强制）')
    expect(text).toContain('### 明显成功案例')
    expect(text).toContain('### false positive')
    expect(text).toContain('t1/a: reset at step 12, passed after')
  })

  it('shows 无 for empty case buckets', () => {
    const report = buildReportData({
      comparison: compareArms([], []),
      cases: [],
      tasks: 0,
      baselineRuns: 0,
      treatmentRuns: 0,
    })
    const text = renderReport(report)
    expect(text).toContain('### regression\n无')
  })
})