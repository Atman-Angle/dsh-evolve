/**
 * Deterministic evaluator (v0.2, spec §10 — Deterministic Eval, Regression
 * Check). The first implementation of the Validation Engine reuses the v0.1
 * eval toolchain; this module provides the deterministic gates used before a
 * candidate may even enter VALIDATING, plus regression checks on promotion.
 *
 * @module dsh-evolve/validation/evaluator
 */

import type { EvidenceSummary } from '../experience/contracts.js'
import { requiredGate } from '../mutation/risk.js'
import type { MutationProposal, ValidationOutcome } from '../mutation/contracts.js'
import type { ReplayReport } from './replay.js'

export interface EvaluationOptions {
  /** Minimum confidence for the proposal's evidence. */
  minConfidence?: number
  /** Minimum replay success rate for skill-like targets. */
  minReplaySuccessRate?: number
  /** Minimum matched sessions for policy targets. */
  minMatchedSessions?: number
}

const DEFAULTS: Required<EvaluationOptions> = {
  minConfidence: 0.4,
  minReplaySuccessRate: 0.5,
  minMatchedSessions: 1,
}

/** Evidence-level gate: does the proposal's evidence justify validation? */
export function evidenceGate(
  proposal: MutationProposal,
  options: EvaluationOptions = {},
): { passed: boolean; detail: string } {
  const opts = { ...DEFAULTS, ...options }
  if (proposal.evidence.confidence < opts.minConfidence) {
    return { passed: false, detail: `confidence ${proposal.evidence.confidence} < ${opts.minConfidence}` }
  }
  return { passed: true, detail: 'evidence gate passed' }
}

/**
 * Replay-level gate: for skill/recipe/policy targets, the change must be
 * supportable by past sessions (non-trivial match + acceptable success rate).
 */
export function replayGate(
  proposal: MutationProposal,
  replay: ReplayReport | undefined,
  options: EvaluationOptions = {},
): { passed: boolean; detail: string } {
  const opts = { ...DEFAULTS, ...options }
  if (replay === undefined) {
    // replay not applicable (e.g. pure memory fact) — not a failure
    return { passed: true, detail: 'replay not applicable' }
  }
  if (replay.totalMatches === 0) {
    return { passed: true, detail: 'no past matches (shadow only)' } // shadow will gather evidence
  }
  if (replay.matchedSessions.length < opts.minMatchedSessions) {
    return { passed: false, detail: `matched ${replay.matchedSessions.length} sessions < ${opts.minMatchedSessions}` }
  }
  const isSkillLike = proposal.target === 'skill-create' || proposal.target === 'skill-update'
  if (isSkillLike && replay.successRate < opts.minReplaySuccessRate) {
    return { passed: false, detail: `replay success rate ${replay.successRate} < ${opts.minReplaySuccessRate}` }
  }
  return { passed: true, detail: 'replay gate passed' }
}

/** Deterministic evaluation of a proposal before VALIDATING. */
export function evaluateProposal(
  proposal: MutationProposal,
  opts: {
    replay?: ReplayReport
    evidence?: EvaluationOptions
  } = {},
): ValidationOutcome {
  const gate = requiredGate(proposal.riskLevel)
  const evidence = evidenceGate(proposal, opts.evidence)
  const replay = replayGate(proposal, opts.replay, opts.evidence)
  const passed = evidence.passed && replay.passed
  return {
    method: gate === 'eval-shadow-rollback' || gate === 'eval' ? 'eval' : 'replay',
    passed,
    detail: [evidence.detail, replay.detail].join('; '),
    at: Date.now(),
  }
}

/** Regression check: promoted change must not worsen past evidence. */
export function regressionCheck(
  before: EvidenceSummary,
  after: EvidenceSummary,
): { passed: boolean; detail: string } {
  const regression = after.successfulOccurrences < before.successfulOccurrences
    || after.confidence < before.confidence - 0.2
  return regression
    ? { passed: false, detail: `regression: success ${before.successfulOccurrences}→${after.successfulOccurrences}, confidence ${before.confidence}→${after.confidence}` }
    : { passed: true, detail: 'no regression detected' }
}
