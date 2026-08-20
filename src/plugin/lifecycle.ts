/**
 * Runtime wiring: registers all observers and the intervention seams against
 * DSH's official events, keeps per-session state, and records evidence in the
 * evolve store. Every registration goes through `ctx.on` (effect-scoped), so
 * plugin unload removes every listener and drops all state.
 *
 * @module dsh-evolve/plugin/lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PolicyRecipe } from '../contracts/recipe.js'
import type { RunSummary } from '../contracts/intervention.js'
import { normalizeSessionEvent } from '../collector/trajectory-collector.js'
import { StuckDetector } from '../detector/stuck-detector.js'
import {
  buildRecord,
  commitInjection,
  createControllerState,
  decideIntervention,
  type ControllerState,
} from '../intervention/controller.js'
import { buildStrategyResetMessage } from '../intervention/strategy-reset.js'
import { EvolveStore, resolveEvolveRoot } from '../storage/evolve-store.js'

/** One session's runtime state; dropped when the session leaves the store. */
interface SessionState {
  detector: StuckDetector
  controller: ControllerState
  /** Fired stuck events (score >= threshold), recorded whether injected or not. */
  stuckEvents: number
  /** Injections performed by this process. */
  injections: number
  /** Session-visible time annotation (start/end of observed events). */
  firstEventTime?: number
  lastEventTime?: number
}

export interface LifecycleDeps {
  recipe: PolicyRecipe
  store: EvolveStore
}

/** Fold a finished session's durable events into a RunSummary. */
export function summarizeSession(
  session: Session,
  extra: {
    stuckEvents: number
    injections: number
    policyId: string
    policyVersion: string
  },
): RunSummary {
  let steps = 0
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let first = Number.POSITIVE_INFINITY
  let last = 0
  let ended: RunSummary['ended'] = 'unknown'
  for (const event of session.events) {
    if (event.time < first) first = event.time
    if (event.time > last) last = event.time
    switch (event.type) {
      case 'step/start': steps += 1; break
      case 'tool/call': toolCalls += 1; break
      case 'assistant/message':
        if (event.data.usage !== undefined) {
          inputTokens += event.data.usage.inputTokens ?? 0
          outputTokens += event.data.usage.outputTokens ?? 0
        }
        break
      case 'turn/end': {
        const kind = event.data.reason.kind
        ended = kind === 'completed' ? 'completed'
          : kind === 'aborted' ? 'aborted'
            : kind === 'blocked' ? 'blocked'
              : kind === 'error' ? 'error'
                : kind === 'max-tokens' ? 'max-tokens'
                  : kind === 'interrupted' ? 'interrupted'
                    : 'unknown'
        break
      }
      default: break
    }
  }
  return {
    sessionId: session.id,
    policyId: extra.policyId,
    policyVersion: extra.policyVersion,
    steps,
    toolCalls,
    inputTokens,
    outputTokens,
    durationMs: last >= first && Number.isFinite(first) ? last - first : 0,
    stuckEvents: extra.stuckEvents,
    interventions: extra.stuckEvents,
    injections: extra.injections,
    ended,
  }
}

/** Count prior dsh-evolve injections already committed to a session's durable log. */
export function countPriorInjections(session: Session): number {
  let count = 0
  for (const event of session.events) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (typeof source === 'object' && source !== null
      && (source as { kind?: unknown }).kind === 'plugin'
      && (source as { plugin?: unknown }).plugin === 'dsh-evolve') {
      count += 1
    }
  }
  return count
}

/** Resolve the live agent for a session through ctx.agents, when available. */
function safeAgent(ctx: Context, sessionId: string): Agent | undefined {
  const agents = (ctx as { agents?: { get(id: string): Agent | undefined } }).agents
  return agents?.get(sessionId)
}

/** Install the runtime plugin's observers. All registrations are ctx.on effects. */
export function install(ctx: Context, deps: LifecycleDeps): void {
  const { recipe, store } = deps
  const states = new Map<SessionId, SessionState>()
  const message = buildStrategyResetMessage(recipe.intervention.messageTemplate)

  function getState(session: Session): SessionState {
    let state = states.get(session.id)
    if (state === undefined) {
      const controller = createControllerState()
      // Recover already-committed injections so maxPerSession survives resume.
      controller.perSession = countPriorInjections(session)
      state = {
        detector: new StuckDetector(recipe.detector),
        controller,
        stuckEvents: 0,
        injections: 0,
      }
      states.set(session.id, state)
    }
    return state
  }

  /** Score the last ended step; record evidence; inject through the seam if gated. */
  function handleFired(session: Session, state: SessionState, turn: number, step: number, seam: 'step-end' | 'turn-stopping'): void {
    const evaluation = state.detector.evaluateLastStep()
    if (evaluation === null || !evaluation.fired) return
    state.stuckEvents += 1
    const globalStep = state.detector.extractor.stepCount
    const decision = decideIntervention(recipe.intervention, state.controller, turn, step, globalStep, seam)
    if (decision.record) {
      const record = buildRecord({
        sessionId: session.id,
        turn,
        step,
        score: evaluation.score,
        reasons: evaluation.reasons,
        policyId: recipe.id,
        policyVersion: recipe.version,
        injected: decision.inject,
        seam: decision.seam,
      })
      store.appendIntervention(record).catch((error: unknown) => {
        ctx.logger.warn(`dsh-evolve: failed to persist intervention record: ${String(error)}`)
      })
    }
    if (!decision.inject) return
    const agent = safeAgent(ctx, session.id)
    if (agent === undefined) return
    if (seam === 'step-end') {
      agent.inject(message)
    } else {
      agent.steer(message)
    }
    commitInjection(state.controller, turn, globalStep)
    state.injections += 1
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (typeof session?.id !== 'string') return
      const state = getState(session)
      if (state.firstEventTime === undefined) state.firstEventTime = event.time
      state.lastEventTime = event.time
      const normalized = normalizeSessionEvent(event)
      if (normalized === null) return
      state.detector.feed(normalized)
      if (normalized.type === 'step/end') {
        handleFired(session, state, normalized.turn, normalized.step, 'step-end')
      }
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-evolve: session/event observer failed: ${String(error)}`)
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      const state = states.get(agent.id)
      if (state === undefined) return
      const signals = state.detector.extractor.signals()
      if (signals.step === 0) return
      handleFired(agent.session, state, turn, signals.step, 'turn-stopping')
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-evolve: turn-stopping observer failed: ${String(error)}`)
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      const state = states.get(session.id)
      if (state === undefined) return
      states.delete(session.id)
      store.writeRunSummary(summarizeSession(session, {
        stuckEvents: state.stuckEvents,
        injections: state.injections,
        policyId: recipe.id,
        policyVersion: recipe.version,
      })).catch((error: unknown) => {
        ctx.logger.warn(`dsh-evolve: failed to persist run summary: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-evolve: session/disposed observer failed: ${String(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
  })
}

export { resolveEvolveRoot }