/**
 * Offline analyzer: replay-style stuck-score evaluation over an already
 * recorded session. Uses the exact same feature extractor and scoring code as
 * the runtime plugin, so "the runtime would trigger at step N" is
 * byte-for-byte reproducible offline.
 *
 * It proves only WHERE a policy would fire, never that firing helps — the
 * latter requires the online eval (docs/experiment-design.md).
 *
 * @module dsh-evolve/offline/analyzer
 */

import type { CollectorEvent } from '../contracts/trajectory.js'
import type { PolicyRecipe } from '../contracts/recipe.js'
import { StuckDetector } from '../detector/stuck-detector.js'
import { normalizeSessionEvent } from '../collector/trajectory-collector.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One step's analysis row. */
export interface AnalysisRow {
  step: number
  score: number
  fired: boolean
  reasons: string[]
}

export interface AnalysisResult {
  sessionId: string
  totalSteps: number
  totalToolCalls: number
  firedEvents: number
  /** dsh-evolve strategy-reset messages actually injected (user/message plugin source). */
  injections: number
  inputTokens: number
  outputTokens: number
  ended: string
  rows: AnalysisRow[]
}

/** Adapt stored session events to the collector vocabulary. */
export function collectorEvents(events: readonly SessionEvent[]): CollectorEvent[] {
  const out: CollectorEvent[] = []
  for (const event of events) {
    const normalized = normalizeSessionEvent(event)
    if (normalized !== null) out.push(normalized)
  }
  return out
}

/** Replay analysis of one session log against one recipe. */
export function analyzeLog(sessionId: string, events: readonly SessionEvent[], recipe: PolicyRecipe): AnalysisResult {
  const detector = new StuckDetector(recipe.detector)
  const rows: AnalysisRow[] = []
  let totalToolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let injections = 0
  let ended = 'unknown'

  for (const event of events) {
    if (event.type === 'tool/call') totalToolCalls += 1
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      inputTokens += event.data.usage.inputTokens ?? 0
      outputTokens += event.data.usage.outputTokens ?? 0
    }
    if (event.type === 'user/message') {
      const source = event.data.source
      if (typeof source === 'object' && source !== null
        && (source as { kind?: unknown }).kind === 'plugin'
        && (source as { plugin?: unknown }).plugin === 'dsh-evolve') {
        injections += 1
      }
    }
    if (event.type === 'turn/end') ended = event.data.reason.kind
    const normalized = normalizeSessionEvent(event)
    if (normalized === null) continue
    detector.feed(normalized)
    if (normalized.type === 'step/end') {
      const evaluation = detector.evaluateLastStep()
      if (evaluation !== null) {
        rows.push({
          step: normalized.step,
          score: Number(evaluation.score.toFixed(2)),
          fired: evaluation.fired,
          reasons: StuckDetector.describeReasons(evaluation.reasons),
        })
      }
    }
  }

  return {
    sessionId,
    totalSteps: rows.length,
    totalToolCalls,
    firedEvents: rows.filter(row => row.fired).length,
    injections,
    inputTokens,
    outputTokens,
    ended,
    rows,
  }
}

/** Render the analysis report in the spec's console format. */
export function renderReport(result: AnalysisResult, recipe: PolicyRecipe): string {
  const lines: string[] = [
    `Session: ${result.sessionId}`,
    `Recipe:  ${recipe.id} v${recipe.version}`,
    `Ended:   ${result.ended}`,
    `Steps:   ${result.totalSteps}   Tool calls: ${result.totalToolCalls}`,
    `Tokens:  ${result.inputTokens} in / ${result.outputTokens} out`,
    '',
  ]
  for (const row of result.rows) {
    lines.push(`Step ${row.step}`)
    lines.push(`stuck score: ${row.score.toFixed(2)}${row.fired ? '   TRIGGER' : ''}`)
    if (row.fired && row.reasons.length > 0) {
      lines.push('Reasons:')
      for (const reason of row.reasons) lines.push(`- ${reason}`)
    }
    lines.push('')
  }
  lines.push(`Detected stuck events: ${result.firedEvents}`)
  return lines.join('\n')
}