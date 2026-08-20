import { describe, expect, it } from 'vitest'
import { FeatureExtractor } from '../src/features/feature-extractor.js'
import type { CollectorEvent } from '../src/contracts/trajectory.js'

const OPTS = { windowSize: 6, mutationTools: ['write', 'bash'], maxNovelWindow: 12 }

interface StepInput {
  turn: number
  step: number
  calls?: { name: string; args: string }[]
  results?: { isError: boolean; text: string; code?: string }[]
}

/** Build one correctly-ordered step: start -> calls -> results -> end. */
function stepEvents(input: StepInput): CollectorEvent[] {
  const { turn, step } = input
  const out: CollectorEvent[] = [{ type: 'step/start', turn, step }]
  for (const call of input.calls ?? []) {
    out.push({ type: 'tool/call', data: { name: call.name, arguments: call.args, turn, step } })
  }
  for (const result of input.results ?? []) {
    out.push({
      type: 'tool/result',
      data: {
        isError: result.isError,
        ...result.code === undefined ? {} : { error: { name: result.code, code: result.code, text: result.text } },
        contentText: result.text,
        turn,
        step,
      },
    })
  }
  out.push({ type: 'step/end', turn, step })
  return out
}

function finish(events: CollectorEvent[], extractor: FeatureExtractor): ReturnType<FeatureExtractor['signals']> {
  for (const event of events) extractor.feed(event)
  return extractor.signals()
}

describe('FeatureExtractor', () => {
  it('returns zeros before any step ends', () => {
    const extractor = new FeatureExtractor(OPTS)
    const signals = extractor.signals()
    expect(signals.step).toBe(0)
    expect(signals.consecutiveFailures).toBe(0)
  })

  it('detects repeated identical calls (B) across steps', () => {
    const extractor = new FeatureExtractor(OPTS)
    const events: CollectorEvent[] = []
    for (let i = 1; i <= 3; i++) {
      events.push(...stepEvents({ turn: 1, step: i, calls: [{ name: 'grep', args: '{"q":"auth"}' }], results: [{ isError: false, text: 'line1\nline2' }] }))
    }
    expect(finish(events, extractor).repeatedActionRun).toBe(3)
  })

  it('breaks the run when arguments differ (edit -> test cycle is not stuck)', () => {
    const extractor = new FeatureExtractor(OPTS)
    const events: CollectorEvent[] = []
    for (let i = 1; i <= 4; i++) {
      events.push(...stepEvents({
        turn: 1, step: i,
        calls: [{ name: 'write', args: JSON.stringify({ file: 'a.ts', content: `v${i}` }) }, { name: 'bash', args: '{"command":"pnpm test"}' }],
        results: [{ isError: false, text: `output ${i}` }],
      }))
    }
    expect(finish(events, extractor).repeatedActionRun).toBe(1)
  })

  it('counts consecutive unproductive failures (A)', () => {
    // The first occurrence of an error is new information (productive), so 3
    // identical failures -> run of 2; a 4th extends it to 3.
    const make = (count: number): CollectorEvent[] => {
      const events: CollectorEvent[] = []
      for (let i = 1; i <= count; i++) {
        events.push(...stepEvents({ turn: 1, step: i, results: [{ isError: true, text: 'Error: boom', code: 'E_BOOM' }] }))
      }
      return events
    }
    const three = new FeatureExtractor(OPTS)
    expect(finish(make(3), three).consecutiveFailures).toBe(2)
    const four = new FeatureExtractor(OPTS)
    expect(finish(make(4), four).consecutiveFailures).toBe(3)
  })

  it('detects repeated error signatures (C)', () => {
    const extractor = new FeatureExtractor(OPTS)
    const events: CollectorEvent[] = []
    for (let i = 1; i <= 3; i++) {
      events.push(...stepEvents({
        turn: 1, step: i,
        calls: [{ name: 'bash', args: '{"command":"node src/index.js"}' }],
        results: [{ isError: true, text: 'Error: Cannot find module "x"', code: 'MODULE_NOT_FOUND' }],
      }))
    }
    expect(finish(events, extractor).repeatedErrorRun).toBe(3)
  })

  it('tracks no-novel-observation steps (D) and resets on novelty', () => {
    const extractor = new FeatureExtractor(OPTS)
    const events: CollectorEvent[] = []
    events.push(...stepEvents({ turn: 1, step: 1, results: [{ isError: false, text: 'alpha' }] }))
    for (let i = 2; i <= 3; i++) {
      events.push(...stepEvents({ turn: 1, step: i, results: [{ isError: false, text: 'alpha' }] }))
    }
    const signals = finish(events, extractor)
    expect(signals.noNovelSteps).toBe(2)
    expect(signals.novelInWindow).toBe(true)
  })

  it('detects mutation success (E: stepsSinceChange)', () => {
    const extractor = new FeatureExtractor(OPTS)
    const events: CollectorEvent[] = []
    events.push(...stepEvents({ turn: 1, step: 1, calls: [{ name: 'write', args: '{}' }], results: [{ isError: false, text: 'written' }] }))
    for (let i = 2; i <= 3; i++) {
      events.push(...stepEvents({ turn: 1, step: i, calls: [{ name: 'read', args: '{}' }], results: [{ isError: false, text: 'same' }] }))
    }
    const signals = finish(events, extractor)
    expect(signals.changedInWindow).toBe(true)
    expect(signals.stepsSinceChange).toBe(2)
  })

  it('bounds the window: old runs do not persist forever', () => {
    const extractor = new FeatureExtractor({ windowSize: 3, mutationTools: ['write'], maxNovelWindow: 6 })
    const events: CollectorEvent[] = []
    for (let i = 1; i <= 3; i++) {
      events.push(...stepEvents({ turn: 1, step: i, calls: [{ name: 'grep', args: '{"q":"a"}' }], results: [{ isError: false, text: 'same' }] }))
    }
    for (let i = 4; i <= 9; i++) {
      events.push(...stepEvents({ turn: 1, step: i, calls: [{ name: 'write', args: JSON.stringify({ v: i }) }], results: [{ isError: false, text: `content${i}` }] }))
    }
    expect(finish(events, extractor).repeatedActionRun).toBe(1)
  })

  it('a human user message resets the window', () => {
    const extractor = new FeatureExtractor(OPTS)
    const events: CollectorEvent[] = []
    for (let i = 1; i <= 3; i++) {
      events.push(...stepEvents({ turn: 1, step: i, calls: [{ name: 'grep', args: '{"q":"a"}' }], results: [{ isError: false, text: 'same' }] }))
    }
    events.push({ type: 'user/message', sourceKind: 'user' })
    for (let i = 4; i <= 5; i++) {
      events.push(...stepEvents({ turn: 1, step: i, calls: [{ name: 'grep', args: '{"q":"a"}' }], results: [{ isError: false, text: 'same' }] }))
    }
    const signals = finish(events, extractor)
    expect(signals.repeatedActionRun).toBe(2)
    expect(signals.consecutiveFailures).toBe(0)
  })

  it('plugin-source messages do not reset the window', () => {
    const extractor = new FeatureExtractor(OPTS)
    const events: CollectorEvent[] = []
    for (let i = 1; i <= 2; i++) {
      events.push(...stepEvents({ turn: 1, step: i, calls: [{ name: 'grep', args: '{"q":"a"}' }], results: [{ isError: false, text: 'same' }] }))
    }
    events.push({ type: 'user/message', sourceKind: 'plugin' })
    events.push(...stepEvents({ turn: 1, step: 3, calls: [{ name: 'grep', args: '{"q":"a"}' }], results: [{ isError: false, text: 'same' }] }))
    expect(finish(events, extractor).repeatedActionRun).toBe(3)
  })
})