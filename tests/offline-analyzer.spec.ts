import { describe, expect, it } from 'vitest'
import { analyzeLog, renderReport } from '../src/offline/analyzer.js'
import { RESET_V1_RECIPE } from '../src/policy/recipe.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent
}

function stuckSession(): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = 0
  const push = (type: string, data: unknown): void => { out.push(ev(type, data, seq++)) }
  push('turn/start', { turn: 1 })
  for (let step = 1; step <= 4; step++) {
    push('step/start', { turn: 1, step })
    push('tool/call', { turn: 1, step, callId: `c${step}`, name: 'bash', arguments: '{"command":"npm i"}' })
    push('tool/result', {
      turn: 1, step,
      message: {
        id: `m${step}`, role: 'user', content: [{ type: 'tool-result', toolCallId: `c${step}`, content: [{ type: 'text', text: 'Error: EACCES' }], isError: true }],
        source: { kind: 'tool', callId: `c${step}` },
      },
      error: { name: 'Error', code: 'EACCES' },
    })
    push('step/end', { turn: 1, step })
  }
  push('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'X' } } })
  return out
}

describe('offline analyzeLog + renderReport', () => {
  it('marks a TRIGGER step and lists reasons', () => {
    const result = analyzeLog('abc123', stuckSession(), RESET_V1_RECIPE)
    expect(result.firedEvents).toBeGreaterThan(0)
    const triggered = result.rows.filter(row => row.fired)
    expect(triggered.length).toBeGreaterThan(0)
    for (const row of triggered) {
      expect(row.reasons.length).toBeGreaterThan(0)
    }
    const report = renderReport(result, RESET_V1_RECIPE)
    expect(report).toContain('Session: abc123')
    expect(report).toContain('TRIGGER')
    expect(report).toContain('Reasons:')
    expect(report).toContain('repeated error signature')
  })

  it('reports the spec-format begin/end', () => {
    const result = analyzeLog('abc123', stuckSession(), RESET_V1_RECIPE)
    const report = renderReport(result, RESET_V1_RECIPE)
    expect(report.split('\n')[0]).toBe('Session: abc123')
    expect(report.trim().endsWith('Detected stuck events:')).toBe(false) // has a count
  })
})