/**
 * Incremental trajectory feature extractor. Pure and deterministic: it
 * consumes {@link CollectorEvent}s in log order and produces
 * {@link StepSignals} at every `step/end`. No IO, no models, no wall clock —
 * the same sequence of events always yields the same signals, which is what
 * makes runtime detections exactly replayable by the offline analyzer.
 *
 * Memory is bounded: only the last {@link FeatureExtractorOptions.windowSize}
 * step outcomes and a capped novelty-reference deque are retained, so runtime
 * cost stays O(windowSize) per step regardless of session length.
 *
 * @module dsh-evolve/features/feature-extractor
 */

import type { StepOutcome, CollectorEvent, ErrorSignature } from '../contracts/trajectory.js'
import type { StepSignals } from '../contracts/signals.js'
import { actionKey } from './invocation-normalizer.js'
import { errorSignatureKey } from './error-normalizer.js'
import { observationFingerprint } from './observation-fingerprint.js'

export interface FeatureExtractorOptions {
  windowSize: number
  /** Tool names treated as workspace mutations for signal E. */
  mutationTools: readonly string[]
  /** Cap on the novelty-reference deque (observations kept for comparison). */
  maxNovelWindow: number
}

/** Default mutation-class tools (first-party write/edit families). */
export const DEFAULT_MUTATION_TOOLS: readonly string[] = [
  'write', 'edit', 'str_replace_editor', 'apply_patch', 'apply_diff',
  'bash', 'pwsh', 'run_code', 'terminal', 'todo_write',
]

/** Longest trailing consecutive run of identical keys in log order. */
function trailingRun(keys: readonly string[]): number {
  let run = 0
  for (let i = keys.length - 1; i >= 0; i--) {
    const current = keys[i]
    if (current === undefined) break
    const previous = keys[i + 1]
    if (previous === undefined || current === previous) {
      run += 1
    } else {
      break
    }
  }
  return run
}

export class FeatureExtractor {
  private readonly windowSize: number
  private readonly mutationTools: ReadonlySet<string>
  private readonly maxNovelWindow: number

  /** Last {@link windowSize} finished step outcomes, oldest first. */
  private readonly window: StepOutcome[] = []
  private totalSteps = 0
  /** Bounded deque of recently seen observation fingerprints (novelty reference). */
  private readonly seenObservations: string[] = []
  /** FIFO of in-flight tool calls (name + owning step) awaiting their result. */
  private readonly pendingCalls: { name: string; step: number }[] = []

  private current: StepOutcome | undefined
  private lastChangeStep = 0

  constructor(options: FeatureExtractorOptions) {
    if (!Number.isInteger(options.windowSize) || options.windowSize < 1) {
      throw new Error('dsh-evolve: windowSize must be a positive integer')
    }
    if (!Number.isInteger(options.maxNovelWindow) || options.maxNovelWindow < options.windowSize) {
      throw new Error('dsh-evolve: maxNovelWindow must be an integer >= windowSize')
    }
    this.windowSize = options.windowSize
    this.mutationTools = new Set(options.mutationTools)
    this.maxNovelWindow = options.maxNovelWindow
  }

  get stepCount(): number {
    return this.totalSteps
  }

  /** The most recent finished step outcome, or undefined before any step ends. */
  lastOutcome(): StepOutcome | undefined {
    return this.window[this.window.length - 1]
  }

  /** Feed one normalized event in log order. */
  feed(event: CollectorEvent): void {
    switch (event.type) {
      case 'step/start': {
        this.current = { turn: event.turn, step: event.step, failures: 0, mutationOk: false, actionKeys: [], errorKeys: [], observationKeys: [], novelCount: 0 }
        break
      }
      case 'step/end': {
        this.ensureOutcome(event.turn, event.step)
        const settled = this.current as StepOutcome
        this.current = undefined
        this.totalSteps += 1
        this.window.push(settled)
        if (this.window.length > this.windowSize) this.window.shift()
        if (settled.mutationOk) this.lastChangeStep = event.step
        break
      }
      case 'user/message': {
        if (event.sourceKind === 'user') this.resetWindow()
        break
      }
      case 'tool/call': {
        this.ensureOutcome(event.data.turn, event.data.step)
        this.current!.actionKeys.push(actionKey(event.data.name, event.data.arguments))
        this.pendingCalls.push({ name: event.data.name, step: event.data.step })
        break
      }
      case 'tool/result': {
        this.ensureOutcome(event.data.turn, event.data.step)
        const outcome = this.current as StepOutcome
        const data = event.data
        if (data.isError) {
          outcome.failures += 1
          if (data.error !== undefined) {
            outcome.errorKeys.push(errorSignatureKey(data.error))
          }
        } else {
          const call = this.takePendingCall(event.data.step)
          if (call !== undefined && this.mutationTools.has(call.name)) {
            outcome.mutationOk = true
          }
        }
        const key = observationFingerprint(data.contentText)
        outcome.observationKeys.push(key)
        if (!this.seenObservations.includes(key)) {
          outcome.novelCount += 1
          this.seenObservations.push(key)
          if (this.seenObservations.length > this.maxNovelWindow) this.seenObservations.shift()
        }
        break
      }
      case 'turn/end':
        break
    }
  }

  /** FIFO pairing of tool/call with its tool/result within the scheduler's model order. */
  private takePendingCall(step: number): { name: string; step: number } | undefined {
    const index = this.pendingCalls.findIndex(call => call.step === step)
    if (index === -1) return undefined
    const call = this.pendingCalls[index]
    this.pendingCalls.splice(index, 1)
    return call
  }

  private ensureOutcome(turn: number, step: number): void {
    if (this.current === undefined || this.current.step !== step) {
      this.current = { turn, step, failures: 0, mutationOk: false, actionKeys: [], errorKeys: [], observationKeys: [], novelCount: 0 }
    }
  }

  /**
   * Forget window history and novelty reference. Treats a human interjection
   * as a change point, so repetition across a user message is never a loop and
   * `stepsSinceChange` restarts from here.
   */
  resetWindow(): void {
    this.window.length = 0
    this.seenObservations.length = 0
    this.lastChangeStep = this.totalSteps
  }

  /** Signals as of the last finished step (all-zero before any step finishes). */
  signals(): StepSignals {
    const last = this.window[this.window.length - 1]
    if (last === undefined) {
      return {
        step: 0, turn: 0, consecutiveFailures: 0, repeatedActionRun: 0,
        repeatedErrorRun: 0, noNovelSteps: 0, stepsSinceChange: 0,
        novelInWindow: false, changedInWindow: false,
      }
    }

    const actionKeys = this.window.flatMap(outcome => outcome.actionKeys)
    const errorKeys = this.window.flatMap(outcome => outcome.errorKeys)

    // Phase 1: whole-window novelty/change flags (never cut off early).
    let novelInWindow = false
    let changedInWindow = false
    for (const outcome of this.window) {
      if (outcome.novelCount > 0) novelInWindow = true
      if (outcome.mutationOk) changedInWindow = true
    }

    // Phase 2: trailing unproductive run (stops at the first productive step).
    let consecutiveFailures = 0
    let noNovelSteps = 0
    for (let i = this.window.length - 1; i >= 0; i--) {
      const outcome = this.window[i]
      if (outcome === undefined) break
      const productive = outcome.novelCount > 0 || outcome.mutationOk
      if (productive) break
      if (outcome.failures > 0) consecutiveFailures += 1
      noNovelSteps += 1
    }

    return {
      step: last.step,
      turn: last.turn,
      consecutiveFailures,
      repeatedActionRun: trailingRun(actionKeys),
      repeatedErrorRun: trailingRun(errorKeys),
      noNovelSteps,
      stepsSinceChange: Math.max(0, this.totalSteps - this.lastChangeStep),
      novelInWindow,
      changedInWindow,
    }
  }
}