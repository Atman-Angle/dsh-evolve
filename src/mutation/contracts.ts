/**
 * Mutation contracts (v0.2, spec §3.2, §8, §9, §11).
 *
 * A Mutation is a proposal to change one evolvable object, backed by
 * Experience + Evidence. Mutations cannot exist without evidence.
 *
 * @module dsh-evolve/mutation/contracts
 */

import type { EvidenceSummary } from '../experience/contracts.js'

/** The nine evolution targets (spec §5). */
export type MutationTarget =
  | 'memory'
  | 'profile'
  | 'skill-create'
  | 'skill-update'
  | 'skill-routing'
  | 'recipe'
  | 'context-policy'
  | 'tool-policy'
  | 'runtime-policy'

/** Promotion state machine (spec §11). */
export type MutationStatus =
  | 'DISCOVERED'
  | 'CANDIDATE'
  | 'VALIDATING'
  | 'ACTIVE'
  | 'DEPRECATED'
  | 'REJECTED'

/** Risk levels per target (spec §9). */
export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Automation gates implied by a risk level. */
export type Gate =
  | 'auto' // risk 0: memory facts
  | 'auto-visible' // risk 1: preference, skill routing
  | 'shadow' // risk 2: recipe
  | 'confirm' // risk 3: skill create/update
  | 'eval' // risk 4: context/tool policy
  | 'eval-shadow-rollback' // risk 5: runtime policy
  | 'human-review' // risk 6: generated code / plugin (not implemented in v0.2)

export interface ValidationOutcome {
  method: 'static' | 'replay' | 'shadow' | 'eval'
  passed: boolean
  detail: string
  /** Unix epoch ms when the validation ran. */
  at: number
}

export interface MutationProposal {
  id: string
  sourceExperienceIds: string[]
  target: MutationTarget
  riskLevel: RiskLevel
  /** Concrete change payload (target-specific). */
  proposedChange: unknown
  evidence: EvidenceSummary
  status: MutationStatus
  /** Latest validation result, when present. */
  validation?: ValidationOutcome
  /** Monotonic proposal version (each promotion/deprecation bumps it). */
  version: number
  createdAt: string
  updatedAt: string
  /** When the mutation was promoted to ACTIVE (for rollback tracing). */
  activatedAt?: string
}

/** How a mutation can be rolled back (recorded on activation). */
export interface RollbackPlan {
  /** Human-readable rollback instructions. */
  description: string
  /** What to restore, target-specific. */
  restore: unknown
}

/** Target metadata used by the registry (audit-friendly). */
export const TARGET_LABELS: Record<MutationTarget, string> = {
  memory: 'Memory',
  profile: 'User / Workspace Profile',
  'skill-create': 'Skill Creation',
  'skill-update': 'Skill Optimization',
  'skill-routing': 'Skill Routing',
  recipe: 'Workflow Recipe',
  'context-policy': 'Context Policy',
  'tool-policy': 'Tool Policy',
  'runtime-policy': 'Runtime Policy',
}
