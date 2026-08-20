import { describe, expect, it } from 'vitest'
import { assessRecovery } from '../src/offline/eval/recovery.js'
import type { InterventionRecord } from '../src/contracts/intervention.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent
}

function step(turn: number, step: number, seqBase: number, opts: { errorText?: string; novelText?: string; mutation?: boolean } = {}): SessionEvent[] {
  let seq = seqBase
  const out: SessionEvent[] = []
  out.push(ev('step/start', { turn, step }, seq++))
  if (opts.mutation === true) {
    out.push(ev('tool/call', { turn, step, callId: `c${step}`, name: 'write', arguments: '{}' }, seq++))
  } else {
    out.push(ev('tool/call', { turn, step, callId: `c${step}`, name: 'grep', arguments: '{"q":"a"}' }, seq++))
  }
  out.push(ev('tool/result', {
    turn, step,
    message: {
      id: `m${step}`, role: 'user', content: [{
        type: 'tool-result', toolCallId: `c${step}`,
        content: [{ type: 'text', text: opts.errorText ?? opts.novelText ?? 'same' }],
        isError: opts.errorText !== undefined,
      }],
      source: { kind: 'tool', callId: `c${step}` },
    },
    ...opts.errorText === undefined ? {} : { error: { name: 'Error', code: 'E1' } },
  }, seq++))
  out.push(ev('step/end', { turn, step }, seq++))
  return out
}

function stuckSteps(count: number, seqBase: number): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = seqBase
  for (let i = 1; i <= count; i++) {
    out.push(...step(1, i, seq, { errorText: 'Error: boom' }))
    seq += 4
  }
  return out
}

function record(step: number, injected = true): InterventionRecord {
  return {
    sessionId: 's', turn: 1, step, score: 0.8, reasons: [{ signal: 'repeated-actions', count: 3 }],
    policyId: 'reset-v1', policyVersion: '1.0.0', injected, seam: injected ? 'step-end' : 'record-only', timestamp: 1,
  }
}

describe('assessRecovery', () => {
  it('returns zeros without injections', () => {
    const events = stuckSteps(3, 0)
    expect(assessRecovery(events, [], false)).toEqual({ injections: 0, recovered: 0, falsePositives: 0 })
  })

  it('counts record-only entries as no intervention', () => {
    const events = stuckSteps(3, 0)
    expect(assessRecovery(events, [record(3, false)], false).injections).toBe(0)
  })

  it('marks an injection as recovered when the run succeeds', () => {
    const events = stuckSteps(3, 0)
    expect(assessRecovery(events, [record(3)], true)).toEqual({ injections: 1, recovered: 1, falsePositives: 0 })
  })

  it('marks an injection as recovered when progress appears within the window', () => {
    const events = [...stuckSteps(3, 0), ...step(1, 4, 12, { novelText: 'new info' })]
    const assessment = assessRecovery(events, [record(3)], false)
    expect(assessment).toEqual({ injections: 1, recovered: 1, falsePositives: 0 })
  })

  it('marks an injection as recovered on a successful mutation step', () => {
    const events = [...stuckSteps(3, 0), ...step(1, 4, 12, { mutation: true })]
    expect(assessRecovery(events, [record(3)], false).recovered).toBe(1)
  })

  it('marks an injection as false positive without progress or success', () => {
    const events = [...stuckSteps(3, 0), ...stuckSteps(3, 12)] // 6 identical stuck steps
    const assessment = assessRecovery(events, [record(3)], false)
    expect(assessment).toEqual({ injections: 1, recovered: 0, falsePositives: 1 })
  })

  it('does not count progress beyond the recovery window', () => {
    const events = [...stuckSteps(6, 0), ...step(1, 7, 24, { novelText: 'late info' })]
    const assessment = assessRecovery(events, [record(3)], false, 3)
    // step 7 is 4 steps after the injection at step 3 -> outside the window.
    expect(assessment.falsePositives).toBe(1)
  })
})