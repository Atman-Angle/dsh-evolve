import { describe, expect, it } from 'vitest'
import { StuckDetector } from '../src/detector/stuck-detector.js'
import { analyzeLog } from '../src/offline/analyzer.js'
import { normalizeSessionEvent } from '../src/collector/trajectory-collector.js'
import { BASELINE_RECIPE } from '../src/policy/recipe.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PolicyRecipe } from '../src/contracts/recipe.js'

const RECIPE: PolicyRecipe = { ...BASELINE_RECIPE, id: 'reset-v1', intervention: { ...BASELINE_RECIPE.intervention, enabled: true } }

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent
}

/** A stored-style session: mixed stuck then recovered trajectory. */
function buildStoredSession(): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = 0
  const push = (type: string, data: unknown): void => { out.push(ev(type, data, seq++)) }
  push('turn/start', { turn: 1 })
  for (let step = 1; step <= 3; step++) {
    push('step/start', { turn: 1, step })
    push('tool/call', { turn: 1, step, callId: `c${step}`, name: 'grep', arguments: '{"q":"auth"}' })
    push('tool/result', {
      turn: 1, step,
      message: {
        id: `m${step}`, role: 'user', content: [{ type: 'tool-result', toolCallId: `c${step}`, content: [{ type: 'text', text: 'same output' }], isError: false }],
        source: { kind: 'tool', callId: `c${step}` },
      },
    })
    push('step/end', { turn: 1, step })
  }
  push('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'X' } } })
  return out
}

describe('runtime == offline replay consistency', () => {
  it('produces identical per-step scores via both paths', () => {
    const stored = buildStoredSession()
    const runtime = new StuckDetector(RECIPE.detector)
    for (const event of stored) {
      const normalized = normalizeSessionEvent(event)
      if (normalized !== null) runtime.feed(normalized)
    }
    const runtimeEval = runtime.evaluateLastStep()

    const offline = analyzeLog('sess-x', stored, RECIPE)
    const lastRow = offline.rows[offline.rows.length - 1]
    expect(lastRow).toBeDefined()
    expect(lastRow!.fired).toBe(runtimeEval!.fired)
    expect(lastRow!.score).toBe(Number(runtimeEval!.score.toFixed(2)))
    expect(lastRow!.reasons).toEqual(StuckDetector.describeReasons(runtimeEval!.reasons))
  })

  it('aggregates tokens and tool calls from stored events', () => {
    const stored = buildStoredSession()
    const offline = analyzeLog('sess-x', stored, RECIPE)
    expect(offline.totalToolCalls).toBe(3)
    expect(offline.totalSteps).toBe(3)
    expect(offline.ended).toBe('error')
  })
})