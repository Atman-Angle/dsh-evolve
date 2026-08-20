/**
 * Target applier (v0.2, Promotion → Target layer).
 *
 * When a mutation is promoted to ACTIVE, this module applies the proposed
 * change to the corresponding target store. Skill changes land as CANDIDATE
 * (they need explicit activation), while risk-0/1/2 targets activate directly.
 *
 * @module dsh-evolve/targets/applier
 */

import type { CorrectionPayload, ProcedurePayload, FactPayload, PreferencePayload } from '../experience/contracts.js'
import type { MutationProposal } from '../mutation/contracts.js'
import { MemoryStore } from './memory/store.js'
import { ProfileStore } from './profile/store.js'
import { SkillStore } from './skill/store.js'
import { draftFromProposal, triggerFromCorrection, triggerFromProcedure } from './skill/generator.js'
import { RecipeStore } from './recipe/store.js'
import { PolicyStore } from './policy/store.js'

export interface TargetStores {
  memory: MemoryStore
  profile: ProfileStore
  skills: SkillStore
  recipes: RecipeStore
  policies: PolicyStore
}

export interface ApplyResult {
  applied: boolean
  detail: string
}

/**
 * Apply an ACTIVE mutation to its target. Returns a human-readable result.
 * For skill targets, this creates/updates a CANDIDATE version (activation
 * stays a separate, explicit step).
 */
export async function applyPromotedMutation(
  proposal: MutationProposal,
  stores: TargetStores,
  now = new Date().toISOString(),
): Promise<ApplyResult> {
  switch (proposal.target) {
    case 'memory': {
      const fact = (proposal.proposedChange as { kind: string; fact: FactPayload }).fact
      await stores.memory.upsert(fact, { sourceMutationId: proposal.id, status: 'ACTIVE', now })
      return { applied: true, detail: `memory fact ${fact.subject}.${fact.property} activated` }
    }
    case 'profile': {
      const preference = (proposal.proposedChange as { kind: string; preference: PreferencePayload }).preference
      await stores.profile.upsert(preference, { sourceMutationId: proposal.id, status: 'ACTIVE', now })
      return { applied: true, detail: `profile preference "${preference.preference}" activated` }
    }
    case 'skill-create': {
      const draft = draftFromProposal(proposal)
      if (draft === undefined) return { applied: false, detail: 'skill-create proposal carries no draft' }
      const existing = await stores.skills.list()
      const dup = existing.find(skill => skill.name === draft.name && skill.source !== 'community')
      if (dup === undefined) {
        await stores.skills.createCandidate(draft, {
          source: 'generated',
          experienceIds: proposal.sourceExperienceIds,
          evidence: proposal.evidence,
          mutationId: proposal.id,
          now,
        })
        return { applied: true, detail: `candidate skill "${draft.name}" created (awaiting approval)` }
      }
      return { applied: true, detail: `candidate skill "${draft.name}" already exists` }
    }
    case 'skill-update': {
      const change = proposal.proposedChange as {
        kind: string
        skillId: string
        fromVersion: number
        change: string
      }
      const skill = await stores.skills.getById(change.skillId)
      if (skill === undefined) return { applied: false, detail: `skill ${change.skillId} not found` }
      await stores.skills.addCandidateVersion(change.skillId, {
        description: skill.versions[skill.versions.length - 1]?.description ?? skill.name,
        instructions: [
          ...(skill.versions[skill.versions.length - 1]?.instructions ?? []),
          `Update (v${change.fromVersion} → v${skill.currentVersion + 1}): ${change.change}`,
        ],
        trigger: skill.versions[skill.versions.length - 1]?.trigger ?? {},
        experienceIds: proposal.sourceExperienceIds,
        evidence: proposal.evidence,
        mutationId: proposal.id,
        now,
      })
      return { applied: true, detail: `skill ${change.skillId} candidate v${skill.currentVersion + 1} created` }
    }
    case 'skill-routing':
      // Routing is learned implicitly from usage; nothing to materialize.
      return { applied: true, detail: 'skill-routing baseline recorded (learned from usage)' }
    case 'recipe': {
      const recipe = await stores.recipes.fromProposal(proposal, now)
      await stores.recipes.setStatus(recipe.id, 'ACTIVE')
      return { applied: true, detail: `workflow recipe "${recipe.name}" activated` }
    }
    case 'context-policy':
    case 'tool-policy':
    case 'runtime-policy': {
      const existing = await stores.policies.getById(`policy_${proposal.id}`)
      if (existing === undefined) {
        await stores.policies.fromProposal(proposal, now)
      }
      await stores.policies.setStatus(`policy_${proposal.id}`, 'ACTIVE', true)
      return { applied: true, detail: `${proposal.target} activated (${proposal.target === 'runtime-policy' ? 'eval+shadow+rollback gate' : 'eval gate'})` }
    }
  }
}

/** Build the procedure trigger used by skill-create for procedure experiences. */
export function procedureTrigger(payload: ProcedurePayload) {
  return triggerFromProcedure(payload)
}

/** Build the correction trigger used by skill-create for corrections. */
export function correctionTrigger(payload: CorrectionPayload) {
  return triggerFromCorrection(payload)
}
