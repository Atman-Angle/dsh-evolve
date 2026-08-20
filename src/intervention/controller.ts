/**
 * Intervention controller: apply the recipe's anti-runaway gates
 * (cooldownSteps / maxPerTurn / maxPerSession) to a fired stuck event and
 * decide whether to inject, and through which seam. After the caps are
 * exhausted the detector keeps recording but never injects (spec §十).
 *
 * Pure decision logic; the caller performs the actual `agent.inject()` /
 * `agent.steer()`.
 *
 * @module dsh-evolve/intervention/controller
 */

import type { InterventionConfig } from '../contracts/recipe.js'
import type { StuckReason } from '../contracts/signals.js'
import type { InterventionRecord } from '../contracts/intervention.js'

export type SplitMode = 'step-end' | 'turn-stopping'

export interface ControllerState {
  /** Global step count (monotonic across turns) of the last injection; 0 = none. */
  lastInjectedGlobalStep: number
  /** Turn in which the last injection happened (per-turn counter basis). */
  lastInjectedTurn: number
  /** Injections in the current turn. */
  perTurn: number
  /** Total injections in this session. */
  perSession: number
  /** Global step last handled (dedupe across seams). */
  lastHandledGlobalStep: number
}

export function createControllerState(): ControllerState {
  return { lastInjectedGlobalStep: 0, lastInjectedTurn: 0, perTurn: 0, perSession: 0, lastHandledGlobalStep: 0 }
}

export interface InterventionDecision {
  /** Whether a stuck event must be persisted (always true on a fired event). */
  record: boolean
  /** Whether the strategy-reset message should be injected. */
  inject: boolean
  seam: SplitMode | 'record-only'
}

/**
 * Decide what to do with a fired stuck event at (turn, step).
 * @param cfg - the active recipe's intervention config.
 * @param state - mutable controller state (updated in place).
 * @param turn - turn of the fired step.
 * @param step - the turn-local step number (recorded as evidence).
 * @param globalStep - the monotonic session step count (cooldown clock).
 * @param seam - which invocation seam is asking.
 */
export function decideIntervention(
  cfg: InterventionConfig,
  state: ControllerState,
  turn: number,
  step: number,
  globalStep: number,
  seam: SplitMode,
): InterventionDecision {
  if (globalStep === state.lastHandledGlobalStep && seam === 'turn-stopping') {
    // This step was already handled at its step-end boundary.
    return { record: false, inject: false, seam: 'record-only' }
  }
  state.lastHandledGlobalStep = globalStep

  if (!cfg.enabled) {
    return { record: true, inject: false, seam: 'record-only' }
  }

  const cooldownOk = state.lastInjectedGlobalStep === 0
    || globalStep - state.lastInjectedGlobalStep >= cfg.cooldownSteps
  const turnBudgetOk = state.lastInjectedTurn !== turn || state.perTurn < cfg.maxPerTurn
  const sessionBudgetOk = state.perSession < cfg.maxPerSession

  if (!cooldownOk || !turnBudgetOk || !sessionBudgetOk) {
    return { record: true, inject: false, seam: 'record-only' }
  }
  return { record: true, inject: true, seam }
}

/** Commit an injection into the controller state (caller must do so after injecting). */
export function commitInjection(state: ControllerState, turn: number, globalStep: number): void {
  state.lastInjectedGlobalStep = globalStep
  if (state.lastInjectedTurn === turn) {
    state.perTurn += 1
  } else {
    state.lastInjectedTurn = turn
    state.perTurn = 1
  }
  state.perSession += 1
}

/** Build the evidence record for a fired event. */
export function buildRecord(input: {
  sessionId: string
  turn: number
  step: number
  score: number
  reasons: StuckReason[]
  policyId: string
  policyVersion: string
  injected: boolean
  seam: SplitMode | 'record-only'
}): InterventionRecord {
  return {
    sessionId: input.sessionId,
    turn: input.turn,
    step: input.step,
    score: input.score,
    reasons: input.reasons,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    injected: input.injected,
    seam: input.seam,
    timestamp: Date.now(),
  }
}