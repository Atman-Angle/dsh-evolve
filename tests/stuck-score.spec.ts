import { describe, expect, it } from 'vitest'
import { stuckScore, saturate } from '../src/detector/stuck-score.js'
import { BASELINE_RECIPE, parseRecipe, validateDetectorConfig } from '../src/policy/recipe.js'
import type { StepSignals } from '../src/contracts/signals.js'

const ZERO: StepSignals = {
  step: 1, turn: 1, consecutiveFailures: 0, repeatedActionRun: 0, repeatedErrorRun: 0,
  noNovelSteps: 0, stepsSinceChange: 0, novelInWindow: true, changedInWindow: true,
}

function signals(partial: Partial<StepSignals>): StepSignals {
  return { ...ZERO, ...partial }
}

describe('saturate', () => {
  it('is linear below threshold and capped at 1', () => {
    expect(saturate(1, 2)).toBe(0.5)
    expect(saturate(2, 2)).toBe(1)
    expect(saturate(5, 2)).toBe(1)
  })
})

describe('stuckScore', () => {
  const detector = BASELINE_RECIPE.detector

  it('scores zero on healthy signals', () => {
    const result = stuckScore(ZERO, detector)
    expect(result.score).toBe(0)
    expect(result.fired).toBe(false)
    expect(result.reasons).toEqual([])
  })

  it('consecutive failures alone can fire at the threshold', () => {
    const result = stuckScore(signals({ consecutiveFailures: 3 }), detector)
    expect(result.score).toBeCloseTo(0.35, 5)
    expect(result.fired).toBe(false) // 0.35 < 0.65
  })

  it('combined signals fire', () => {
    const result = stuckScore(signals({
      consecutiveFailures: 3, repeatedErrorRun: 2, noNovelSteps: 4,
    }), detector)
    expect(result.score).toBeCloseTo(0.35 + 0.25 + 0.15, 5)
    expect(result.fired).toBe(true)
    expect(result.reasons.map(r => r.signal)).toEqual(
      expect.arrayContaining(['consecutive-failures', 'repeated-errors', 'no-novel-observation']),
    )
  })

  it('discounts repeated actions when no state changed', () => {
    const stuck = stuckScore(signals({
      repeatedActionRun: 3, novelInWindow: false, changedInWindow: false,
    }), detector)
    const healthy = stuckScore(signals({
      repeatedActionRun: 3, novelInWindow: true, changedInWindow: false,
    }), detector)
    // discount 0.5: with novelty the term is 1.0, without it 0.5
    expect(stuck.score).toBeCloseTo(0.25 * 0.5, 5)
    expect(healthy.score).toBeCloseTo(0.25, 5)
  })

  it('workspaceChange term is off by default', () => {
    const result = stuckScore(signals({ stepsSinceChange: 99 }), detector)
    expect(result.contributions['no-workspace-change']).toBe(0)
  })

  it('reports contributions for every signal', () => {
    const result = stuckScore(ZERO, detector)
    expect(Object.keys(result.contributions)).toEqual([
      'consecutive-failures', 'repeated-actions', 'repeated-errors',
      'no-novel-observation', 'no-workspace-change',
    ])
  })
})

describe('recipe validation', () => {
  it('accepts the builtin recipes', () => {
    for (const recipe of [BASELINE_RECIPE]) {
      validateDetectorConfig(recipe.detector)
      expect(parseRecipe(recipe)).toBeDefined()
    }
  })

  it('rejects a zero window', () => {
    expect(() => validateDetectorConfig({ ...BASELINE_RECIPE.detector, windowSize: 0 })).toThrow(/windowSize/)
  })

  it('rejects weights that do not sum to 1 when nonzero', () => {
    const detector = structuredClone(BASELINE_RECIPE.detector)
    detector.consecutiveFailures.weight = 0.5
    expect(() => validateDetectorConfig(detector)).toThrow(/weights/)
  })

  it('rejects an out-of-range noveltyDiscount', () => {
    const detector = structuredClone(BASELINE_RECIPE.detector)
    detector.repeatedActions.noveltyDiscount = 2
    expect(() => validateDetectorConfig(detector)).toThrow(/noveltyDiscount/)
  })

  it('rejects an unknown intervention type', () => {
    expect(() => parseRecipe({
      ...BASELINE_RECIPE,
      intervention: { ...BASELINE_RECIPE.intervention, type: 'stop' },
    })).toThrow(/intervention type/)
  })
})