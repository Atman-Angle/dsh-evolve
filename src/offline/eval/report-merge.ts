/**
 * Report merge: combine baseline and treatment eval records (written by
 * `dsh-evolve eval --arm ...`) into the full two-arm comparison report.
 *
 * @module dsh-evolve/offline/eval/report-merge
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareArms } from './metrics.js'
import { buildReportData, renderReport } from './report.js'
import type { CaseNote, EvalRunResult, ReportData } from '../../contracts/eval.js'

/** Read every run record (`<taskDir>/<run>.json`) under an evals directory. */
export async function readEvalRecords(evalsDir: string): Promise<EvalRunResult[]> {
  const taskDirs = await readdir(evalsDir, { withFileTypes: true }).catch(() => [])
  const records: EvalRunResult[] = []
  for (const taskDir of taskDirs) {
    if (!taskDir.isDirectory() || taskDir.name.startsWith('_')) continue
    const files = await readdir(join(evalsDir, taskDir.name), { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      try {
        const content = await readFile(join(evalsDir, taskDir.name, file.name), 'utf8')
        records.push(JSON.parse(content) as EvalRunResult)
      } catch (error) {
        throw new Error(`report: cannot read ${taskDir.name}/${file.name}: ${String(error)}`)
      }
    }
  }
  return records
}

/** Build the full two-arm report from two evals directories. */
export async function buildComparisonReport(input: {
  baselineEvals: string
  treatmentEvals: string
  tasks?: number
  model?: string
  cases?: CaseNote[]
  generatedAt?: string
}): Promise<ReportData> {
  const baseline = await readEvalRecords(input.baselineEvals)
  const treatment = await readEvalRecords(input.treatmentEvals)
  const taskCount = input.tasks ?? new Set([
    ...baseline.map(record => record.taskId),
    ...treatment.map(record => record.taskId),
  ]).size
  return buildReportData({
    comparison: compareArms(baseline, treatment),
    cases: input.cases ?? [],
    tasks: taskCount,
    baselineRuns: baseline.length,
    treatmentRuns: treatment.length,
    ...input.model === undefined ? {} : { model: input.model },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  })
}

export { renderReport }