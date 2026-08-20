/**
 * Promotion flow (v0.2, spec §10, §11).
 *
 * Orchestrates CANDIDATE → VALIDATING → ACTIVE honoring the risk gate:
 * - risk 0/1 (auto, auto-visible): promote directly (evidence-eligible);
 * - risk 2 (shadow): promote after replay/shadow validation;
 * - risk 3 (confirm): validate, then require a human decision;
 * - risk 4/5 (eval, eval-shadow-rollback): validate, then promote by policy
 *   decision (rollback available).
 *
 * Every promotion is recorded in the mutation history and applied to the
 * target store.
 *
 * @module dsh-evolve/validation/promotion
 */

import type { CollectorEvent } from '../contracts/trajectory.js'
import { requiredGate, gateForTarget, evidenceEligible } from '../mutation/risk.js'
import { MutationRegistry } from '../mutation/registry.js'
import type { MutationProposal } from '../mutation/contracts.js'
import { applyPromotedMutation, type TargetStores } from '../targets/applier.js'
import { evaluateProposal } from './evaluator.js'
import { replaySkillProposal, replayPolicyProposal } from './replay.js'

export interface PromotionOptions {
  approver: 'auto' | 'user' | 'policy'
  /** Past sessions for replay validation (optional). */
  sessions?: ReadonlyMap<string, readonly CollectorEvent[]>
  now?: string
}

export type PromotionOutcome =
  | 'promoted'
  | 'needs-approval'
  | 'validation-failed'
  | 'ineligible'
  | 'not-found'

export interface PromotionResult {
  outcome: PromotionOutcome
  detail: string
}

/** Run the full promotion flow for one proposal id. */
export async function runPromotionFlow(
  registry: MutationRegistry,
  stores: TargetStores,
  id: string,
  options: PromotionOptions,
): Promise<PromotionResult> {
  const stored = await registry.getById(id)
  if (stored === undefined) return { outcome: 'not-found', detail: `unknown mutation ${id}` }
  if (stored.status === 'ACTIVE') return { outcome: 'promoted', detail: 'already active' }
  if (stored.status === 'REJECTED' || stored.status === 'DEPRECATED') {
    return { outcome: 'ineligible', detail: `status ${stored.status}` }
  }
  const gate = requiredGate(stored.riskLevel)
  const eligible = evidenceEligible(stored.evidence, stored.riskLevel)
  if (!eligible) return { outcome: 'ineligible', detail: `evidence below eligibility for risk ${stored.riskLevel}` }
  // DISCOVERED → CANDIDATE once evidence is eligible (planner starts DISCOVERED).
  if (stored.status === 'DISCOVERED') {
    await registry.transition(id, 'CANDIDATE', 'evidence eligible')
  }

  // Validate before promotion for any non-auto gate.
  const needsValidation = gate !== 'auto' && gate !== 'auto-visible'
  if (needsValidation) {
    const fresh = await registry.getById(id)
    if (fresh === undefined) return { outcome: 'not-found', detail: `unknown mutation ${id}` }
    const replay = options.sessions === undefined
      ? undefined
      : fresh.target === 'skill-create' || fresh.target === 'skill-update'
        ? replaySkillProposal(fresh, options.sessions)
        : fresh.target === 'runtime-policy' || fresh.target === 'context-policy' || fresh.target === 'tool-policy'
          ? replayPolicyProposal(fresh, options.sessions)
          : undefined
    const outcome = evaluateProposal(fresh, replay === undefined ? {} : { replay })
    if (fresh.status === 'CANDIDATE') await registry.transition(id, 'VALIDATING', 'validation started')
    if (!outcome.passed) {
      await registry.transition(id, 'CANDIDATE', `validation failed: ${outcome.detail}`)
      return { outcome: 'validation-failed', detail: outcome.detail }
    }
    await registry.transition(id, 'CANDIDATE', 'validation recorded') // VALIDATING → CANDIDATE with result
  }

  if (gate === 'confirm' && options.approver !== 'user') {
    return { outcome: 'needs-approval', detail: 'skill changes require human approval (confirm gate)' }
  }

  let promoted
  try {
    promoted = await registry.promote(id, { gate, validationPassed: true, approver: options.approver })
  } catch (error) {
    return {
      outcome: 'needs-approval',
      detail: `promotion blocked by gate ${gate}: ${(error as Error).message}`,
    }
  }
  const applied = await applyPromotedMutation(promoted, stores, options.now)
  return {
    outcome: 'promoted',
    detail: `${applied.detail} (gate ${gate}, approver ${options.approver})`,
  }
}

/** Convenience: gate a proposal without the registry (pure decision). */
export function promotionDecision(proposal: MutationProposal): {
  gate: ReturnType<typeof gateForTarget>
  needsHuman: boolean
} {
  const gate = gateForTarget(proposal.target)
  return { gate, needsHuman: gate === 'confirm' || gate === 'human-review' }
}
