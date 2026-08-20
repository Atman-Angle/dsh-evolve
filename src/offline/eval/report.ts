/**
 * Automatic experiment report: renders reports/latest.md from a
 * {@link ReportData} in the spec's format, including the mandatory cases
 * section (success / failure / false-positive / regression).
 *
 * @module dsh-evolve/offline/eval/report
 */

import type { Comparison, Metrics, ReportData } from '../../contracts/eval.js'

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function row(label: string, baseline: string, treatment: string, delta?: string): string {
  return `| ${label} | ${baseline} | ${treatment} | ${delta ?? ''} |`
}

/** Render one arm's metrics table columns. */
function metricTable(c: Comparison): string {
  const b = c.baseline
  const t = c.treatment
  const lines: string[] = [
    '| Metric | Baseline | Evolve | Δ |',
    '|---|---|---|---|',
    row('Success', pct(b.successRate), pct(t.successRate), c.successDeltaPp === undefined ? '' : `${fmtPp(c.successDeltaPp)}pp`),
    row('Avg steps', fmt(b.avgSteps), fmt(t.avgSteps), c.avgStepsDelta === undefined ? '' : fmtSigned(c.avgStepsDelta)),
    row('Avg input tokens', fmtOpt(b.avgInputTokens), fmtOpt(t.avgInputTokens), c.avgInputTokensDelta === undefined ? '' : fmtSigned(c.avgInputTokensDelta)),
    row('Avg latency (ms)', fmt(b.avgDurationMs), fmt(t.avgDurationMs), c.avgDurationMsDelta === undefined ? '' : fmtSigned(c.avgDurationMsDelta)),
    row('Stuck runs', pct(b.stuckRate), pct(t.stuckRate), c.stuckRateDeltaPp === undefined ? '' : `${fmtPp(c.stuckRateDeltaPp)}pp`),
  ]
  return lines.join('\n')
}

function fmtPp(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`
}

function fmt(value: number): string {
  return value.toFixed(1)
}

function fmtOpt(value: number | undefined): string {
  return value === undefined ? '—' : fmt(value)
}

function fmtSigned(value: number): string {
  return value >= 0 ? `+${fmt(value)}` : fmt(value)
}

/** Render the full report markdown. */
export function renderReport(report: ReportData): string {
  const c = report.comparison
  const lines: string[] = [
    '# dsh-evolve experiment',
    '',
    `Dataset: ${report.dataset.tasks} tasks`,
    report.model === undefined ? '' : `Model: ${report.model}`,
    `Runs: ${report.runs.baseline} baseline / ${report.runs.treatment} treatment`,
    '',
    metricTable(c),
    '',
    `Interventions: ${c.treatmentInterventions}`,
    `Recovered: ${c.recovered}`,
    `False positives: ${c.falsePositives}`,
    '',
  ]

  const caseBlocks: Record<string, string[]> = {
    success: [],
    failure: [],
    'false-positive': [],
    regression: [],
  }
  for (const item of report.cases) {
    caseBlocks[item.kind]?.push(`- ${item.taskId}/${item.runId}: ${item.note}`)
  }
  lines.push('## 案例（强制）', '')
  for (const [kind, items] of Object.entries(caseBlocks)) {
    const label = kind === 'success' ? '明显成功案例'
      : kind === 'failure' ? '明显失败案例'
        : kind === 'false-positive' ? 'false positive'
          : 'regression'
    lines.push(`### ${label}`, '')
    lines.push(items.length > 0 ? items.join('\n') : '无', '')
  }
  lines.push(`---`, '', `Generated: ${report.generatedAt}`, '')
  return lines.filter(line => line !== '').join('\n')
}

/** Build ReportData from a comparison and raw case notes. */
export function buildReportData(input: {
  comparison: Comparison
  cases: ReportData['cases']
  tasks: number
  baselineRuns: number
  treatmentRuns: number
  model?: string
  generatedAt?: string
}): ReportData {
  return {
    dataset: { tasks: input.tasks },
    ...input.model === undefined ? {} : { model: input.model },
    runs: { baseline: input.baselineRuns, treatment: input.treatmentRuns },
    comparison: input.comparison,
    cases: input.cases,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  }
}

export { aggregateMetrics, compareArms } from './metrics.js'
export type { Metrics } from '../../contracts/eval.js'