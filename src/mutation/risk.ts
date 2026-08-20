/**
 * Mutation risk model (v0.2, spec §9).
 *
 * Each target has a fixed risk level; the risk level determines the minimum
 * automation gate before a mutation may be promoted to ACTIVE.
 *
 * @module dsh-evolve/mutation/risk
 */

import type { Gate, MutationTarget, RiskLevel } from './contracts.js'

/** Risk level per target (spec §9 table). */
export const TARGET_RISK: Record<MutationTarget, RiskLevel> = {
  memory: 0,
  profile: 1,
  'skill-routing': 1,
  recipe: 2,
  'skill-update': 3,
  'skill-create': 3,
  'context-policy': 4,
  'tool-policy': 4,
  'runtime-policy': 5,
}

/** The automation gate required for a risk level. */
export function requiredGate(risk: RiskLevel): Gate {
  switch (risk) {
    case 0: return 'auto'
    case 1: return 'auto-visible'
    case 2: return 'shadow'
    case 3: return 'confirm'
    case 4: return 'eval'
    case 5: return 'eval-shadow-rollback'
    case 6: return 'human-review'
  }
}

/** Gate for a target (convenience). */
export function gateForTarget(target: MutationTarget): Gate {
  return requiredGate(TARGET_RISK[target])
}

/** Whether a gate permits activation without a human decision. */
export function gateAllowsAutoActivation(gate: Gate): boolean {
  return gate === 'auto' || gate === 'auto-visible' || gate === 'shadow'
}

/**
 * Whether a mutation may be auto-activated given its gate and validation
 * history. Higher-risk gates require evidence of validation first.
 */
export function canAutoActivate(gate: Gate, validationPassed: boolean): boolean {
  switch (gate) {
    case 'auto':
    case 'auto-visible':
      return true
    case 'shadow':
      return validationPassed
    case 'eval':
    case 'eval-shadow-rollback':
      return validationPassed
    case 'confirm':
    case 'human-review':
      return false // always needs a human decision
  }
}

/** Minimum evidence before a proposal may even be created (conservative). */
export function evidenceEligible(evidence: {
  sessions: number
  occurrences: number
  confidence: number
}, risk: RiskLevel): boolean {
  if (risk <= 1) return evidence.occurrences >= 1
  if (risk === 2) return evidence.sessions >= 1 && evidence.occurrences >= 2
  return evidence.sessions >= 2 && evidence.occurrences >= 3
}
