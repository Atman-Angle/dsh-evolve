/**
 * Mutation planner (v0.2, spec §8).
 *
 * Maps experiences to mutation proposals. Deterministic and pure: given the
 * same experiences (and the same optional context), it produces the same
 * proposals. Duplicate proposals (same target fed by the same experience) are
 * suppressed so the registry does not accumulate spam.
 *
 * Target mapping:
 * - fact → memory (risk 0)
 * - preference → profile (risk 1)
 * - correction → skill-create (risk 3); skill-update when an existing skill
 *   already claims the failed step
 * - successful-procedure → skill-create (risk 3); recipe (risk 2) when the
 *   procedure is long enough to be a phase-level organization
 * - failure-pattern → runtime-policy (risk 5); context-policy (risk 4) when
 *   the suggested action is context-scoped
 *
 * @module dsh-evolve/mutation/planner
 */

import { fingerprint } from '../features/hash.js'
import type {
  CorrectionPayload,
  ExperienceRecord,
  FailurePatternPayload,
  PreferencePayload,
  ProcedurePayload,
} from '../experience/contracts.js'
import { TARGET_RISK } from './risk.js'
import type { MutationProposal, MutationTarget } from './contracts.js'

/** Minimal skill view the planner uses to decide update-vs-create. */
export interface SkillTriggerView {
  id: string
  name: string
  version: number
  /** Action keys the skill is known to cover. */
  triggerActionKeys: string[]
}

export interface PlanOptions {
  /** Existing proposals (avoids duplicates). */
  existingProposals?: readonly MutationProposal[]
  /** Active skills (enables skill-update proposals). */
  existingSkills?: readonly SkillTriggerView[]
  now?: string
  /** Explicit user-confirmed distillation of experiences into a Skill. */
  distillSkill?: boolean
}

/** Whether an experience is still evolvable (not rejected/deprecated). */
export function isEvolvable(record: ExperienceRecord): boolean {
  return record.status === 'DISCOVERED' || record.status === 'CANDIDATE' || record.status === 'VALIDATING'
}

function proposalId(target: MutationTarget, experienceId: string): string {
  return `mut_${fingerprint(`${target}:${experienceId}`).slice(0, 24)}`
}

function baseProposal(
  target: MutationTarget,
  experience: ExperienceRecord,
  proposedChange: unknown,
  now: string,
): MutationProposal {
  return {
    id: proposalId(target, experience.id),
    sourceExperienceIds: [experience.id],
    target,
    riskLevel: TARGET_RISK[target],
    proposedChange,
    evidence: experience.evidence,
    status: 'DISCOVERED',
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

/** Find an active skill that claims a correction's failed action key. */
function matchingSkill(
  failedActionKey: string,
  skills: readonly SkillTriggerView[] | undefined,
): SkillTriggerView | undefined {
  if (skills === undefined) return undefined
  return skills.find(skill => skill.triggerActionKeys.includes(failedActionKey))
}

/** Generate the skill draft for a correction (the MVP chain). */
export function draftSkillFromCorrection(
  experience: ExperienceRecord,
  payload: CorrectionPayload,
): { name: string; description: string; trigger: Record<string, unknown>; instructions: string[] } {
  const failedTool = payload.failed.tool
  const succeededTool = payload.succeeded.tool
  const name = `${succeededTool}-after-${failedTool}-correction`
  const trigger = {
    actionKeys: [payload.failed.actionKey, payload.succeeded.actionKey],
    tools: [failedTool, succeededTool],
    keywords: [failedTool, succeededTool],
  }
  const instructions = [
    `When a ${failedTool} call matches the known failing pattern (${payload.failed.args}), prefer the corrected approach instead.`,
    `Use ${succeededTool} with ${payload.succeeded.args} rather than repeating ${failedTool} with ${payload.failed.args}.`,
    `Relevant error signatures: ${payload.failureKeys.join(', ') || 'unknown'}.`,
  ]
  return {
    name,
    description: `Avoids the repeatedly-corrected ${failedTool} step (from experience ${experience.id}).`,
    trigger,
    instructions,
  }
}

function draftSkillFromProcedure(
  experience: ExperienceRecord,
  payload: ProcedurePayload,
): { name: string; description: string; trigger: Record<string, unknown>; instructions: string[] } {
  const tools = payload.steps.map(step => step.tool)
  const firstTool = tools[0] ?? 'task'
  const name = `${firstTool}-procedure`
  const instructions = payload.steps.map((step, index) =>
    `${index + 1}. Invoke ${step.tool} following the corrected procedure step.`,
  )
  return {
    name,
    description: `Reusable ${tools.join(' → ')} procedure (from experience ${experience.id}).`,
    trigger: { tools: [...new Set(tools)], keywords: [...new Set(tools)] },
    instructions,
  }
}

/**
 * Plan mutations for evolvable experiences.
 * @param experiences - stored experiences (any status).
 * @param options - dedupe context + skills + clock.
 */
export function planMutations(
  experiences: readonly ExperienceRecord[],
  options: PlanOptions = {},
): MutationProposal[] {
  const now = options.now ?? new Date().toISOString()
  const existingTargets = new Set(
    (options.existingProposals ?? []).map(proposal => proposal.target),
  )
  const proposals: MutationProposal[] = []

  for (const experience of experiences) {
    if (!isEvolvable(experience)) continue
    const sourceTargets = new Set(
      (options.existingProposals ?? [])
        .filter(proposal => proposal.sourceExperienceIds.includes(experience.id))
        .map(proposal => proposal.target),
    )

    switch (experience.kind) {
      case 'fact': {
        if (sourceTargets.has('memory') || existingTargets.has('memory')) break
        proposals.push(baseProposal('memory', experience, {
          kind: 'memory-fact',
          fact: experience.payload,
        }, now))
        break
      }
      case 'preference': {
        if (sourceTargets.has('profile')) break
        proposals.push(baseProposal('profile', experience, {
          kind: 'profile-preference',
          preference: experience.payload as PreferencePayload,
        }, now))
        break
      }
      case 'correction': {
        if (!options.distillSkill) break
        const payload = experience.payload as CorrectionPayload
        const skill = matchingSkill(payload.failed.actionKey, options.existingSkills)
        if (skill !== undefined) {
          if (sourceTargets.has('skill-update')) break
          proposals.push(baseProposal('skill-update', experience, {
            kind: 'skill-update-spec',
            skillId: skill.id,
            fromVersion: skill.version,
            change: `replace failed ${payload.failed.tool} approach with the corrected ${payload.succeeded.tool} approach`,
          }, now))
        } else {
          if (sourceTargets.has('skill-create')) break
          proposals.push(baseProposal('skill-create', experience, {
            kind: 'skill-draft',
            skill: draftSkillFromCorrection(experience, payload),
          }, now))
        }
        break
      }
      case 'successful-procedure': {
        if (!options.distillSkill) break
        const payload = experience.payload as ProcedurePayload
        const longProcedure = payload.steps.length >= 5
        if (longProcedure) {
          if (sourceTargets.has('recipe')) break
          proposals.push(baseProposal('recipe', experience, {
            kind: 'workflow-recipe',
            phases: payload.steps.map(step => step.tool),
          }, now))
        } else {
          if (sourceTargets.has('skill-create')) break
          proposals.push(baseProposal('skill-create', experience, {
            kind: 'skill-draft',
            skill: draftSkillFromProcedure(experience, payload),
          }, now))
        }
        break
      }
      case 'failure-pattern': {
        // A policy proposal is diagnostic evidence only; activation remains
        // behind eval/shadow/rollback and explicit approval.
        const payload = experience.payload as FailurePatternPayload
        const contextScoped = payload.recommendedAction === 'COMPACT_OLD_TOOL_RESULTS'
        const target: MutationTarget = contextScoped ? 'context-policy' : 'runtime-policy'
        if (sourceTargets.has(target)) break
        proposals.push(baseProposal(target, experience, {
          kind: 'policy-change',
          pattern: payload,
        }, now))
        break
      }
    }
  }
  return proposals
}
