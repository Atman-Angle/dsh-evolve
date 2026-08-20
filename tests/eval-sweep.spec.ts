import { describe, expect, it } from 'vitest'
import { sweepTriggerScores, isBadOutcome, renderSweep } from '../src/offline/eval/sweep.js'
import { RESET_V1_RECIPE } from '../src/policy/recipe.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent
}

function step(turn: number, step: number, seqBase: number, error: boolean): SessionEvent[] {
  let seq = seqBase
  const out: SessionEvent[] = []
  out.push(ev('step/start', { turn, step }, seq++))
  out.push(ev('tool/call', { turn, step, callId: `c${step}`, name: 'bash', arguments: '{"command":"node x.js"}' }, seq++))
  out.push(ev('tool/result', {
    turn, step,
    message: {
      id: `m${step}`, role: 'user', content: [{
        type: 'tool-result', toolCallId: `c${step}`,
        content: [{ type: 'text', text: error ? 'Error: boom' : 'ok output' }], isError: error,
      }],
      source: { kind: 'tool', callId: `c${step}` },
    },
    ...error ? { error: { name: 'Error', code: 'E1' } } : {},
  }, seq++))
  out.push(ev('step/end', { turn, step }, seq++))
  return out
}

function session(seqBase: number, stuckStepsCount: number, endReason: string): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = seqBase
  out.push(ev('turn/start', { turn: 1 }, seq++))
  for (let i = 1; i <= stuckStepsCount; i++) {
    out.push(...step(1, i, seq, true))
    seq += 4
  }
  out.push(ev('turn/end', { turn: 1, reason: { kind: endReason, ...endReason === 'error' ? { error: { message: 'x', code: 'X' } } : {} } }, seq++))
  return out
}

const DETECTOR = RESET_V1_RECIPE.detector

describe('isBadOutcome', () => {
  it('classifies error/aborted/max-tokens/blocked as bad', () => {
    expect(isBadOutcome(session(0, 1, 'error'))).toBe(true)
    expect(isBadOutcome(session(0, 1, 'aborted'))).toBe(true)
    expect(isBadOutcome(session(0, 1, 'max-tokens'))).toBe(true)
    expect(isBadOutcome(session(0, 1, 'blocked'))).toBe(true)
  })

  it('classifies completed as good', () => {
    expect(isBadOutcome(session(0, 1, 'completed'))).toBe(false)
  })
})

describe('sweepTriggerScores', () => {
  it('computes precision/recall/FPR across the grid', () => {
    const corpus = new Map<string, readonly SessionEvent[]>([
      // bad runs that will fire at low thresholds
      ['stuck-error-1', session(0, 6, 'error')],
      ['stuck-error-2', session(1000, 6, 'error')],
      // bad run that never fires (single failure, not stuck)
      ['single-fail', session(2000, 1, 'error')],
      // good run that never fires
      ['healthy', session(3000, 1, 'completed')],
      // good run that fires only at a low threshold (score ~0.57, not 0.65)
      ['noisy-good', session(4000, 2, 'completed')],
    ])
    const result = sweepTriggerScores(corpus, [0.4, 0.65], DETECTOR)
    expect(result.sessions).toBe(5)
    expect(result.badRuns).toBe(3)

    const low = result.points[0]!
    expect(low.triggerScore).toBe(0.4)
    expect(low.truePositives).toBe(2)
    expect(low.falsePositives).toBe(1) // noisy-good fires at 0.4
    expect(low.precision).toBeCloseTo(2 / 3, 5)

    const high = result.points[1]!
    expect(high.triggerScore).toBe(0.65)
    expect(high.truePositives).toBe(2)
    expect(high.falsePositives).toBe(0)
    expect(high.falseNegatives).toBe(1) // single-fail never fires
    expect(high.recall).toBeCloseTo(2 / 3, 5)
  })

  it('renders a report without error', () => {
    const result = sweepTriggerScores(new Map(), [0.65], DETECTOR)
    expect(renderSweep(result)).toContain('Sessions: 0')
  })
})