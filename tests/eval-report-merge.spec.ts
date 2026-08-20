import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildComparisonReport, readEvalRecords, renderReport } from '../src/offline/eval/report-merge.js'
import type { EvalRunResult } from '../src/contracts/eval.js'

function record(taskId: string, runId: string, policyId: string, success: boolean, steps: number): EvalRunResult {
  return {
    taskId, runId, policyId, success, steps,
    toolCalls: steps, durationMs: 1000, stuckEvents: 0, interventions: 0,
  }
}

async function writeEvals(dir: string, records: EvalRunResult[]): Promise<void> {
  for (const record of records) {
    await mkdir(join(dir, record.taskId), { recursive: true })
    await writeFile(join(dir, record.taskId, `${record.runId}.json`), JSON.stringify(record), 'utf8')
  }
}

describe('report merge', () => {
  it('reads records from both evals dirs and renders the comparison', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-report-'))
    const baseline = join(root, 'baseline')
    const treatment = join(root, 'treatment')
    await writeEvals(baseline, [
      record('t1', 'b1', 'baseline', true, 20),
      record('t1', 'b2', 'baseline', false, 22),
    ])
    await writeEvals(treatment, [
      record('t1', 'x1', 'treatment', true, 17),
      record('t1', 'x2', 'treatment', true, 19),
    ])

    expect((await readEvalRecords(baseline)).length).toBe(2)
    const report = await buildComparisonReport({ baselineEvals: baseline, treatmentEvals: treatment, model: 'm' })
    expect(report.runs).toEqual({ baseline: 2, treatment: 2 })
    expect(report.comparison.successDeltaPp).toBe(50)
    expect(report.comparison.avgStepsDelta).toBe(-3)
    const text = renderReport(report)
    expect(text).toContain('| Success | 50.0% | 100.0% | +50pp |')
    expect(text).toContain('Model: m')
  })

  it('rejects a corrupt record file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-report-'))
    await mkdir(join(root, 't1'), { recursive: true })
    await writeFile(join(root, 't1', 'bad.json'), '{not json', 'utf8')
    await expect(readEvalRecords(root)).rejects.toThrow(/cannot read/)
  })
})