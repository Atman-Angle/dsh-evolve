/**
 * Skill generator (v0.2, Target 3 — Skill Creation).
 *
 * Turns a skill-create mutation proposal into a candidate skill draft. The
 * planner already produced the draft shape; this module adapts proposals into
 * store-ready input and derives trigger metadata from correction/procedure
 * evidence.
 *
 * @module dsh-evolve/targets/skill/generator
 */

import type { MutationProposal } from '../../mutation/contracts.js'
import type { CorrectionPayload, ProcedurePayload } from '../../experience/contracts.js'
import { procedureStepKey } from '../../experience/miner.js'
import { actionKey } from '../../features/invocation-normalizer.js'
import type { SkillDraft, SkillTrigger } from './model.js'

/** Extract the skill draft from a skill-create proposal. */
export function draftFromProposal(proposal: MutationProposal): SkillDraft | undefined {
  const change = proposal.proposedChange as { kind?: string; skill?: SkillDraft } | undefined
  if (change?.kind === 'skill-draft' && change.skill !== undefined) return change.skill
  return undefined
}

/** Trigger derived from a correction: match the failed action to prevent it. */
export function triggerFromCorrection(payload: CorrectionPayload): SkillTrigger {
  return {
    actionKeys: [payload.failed.actionKey],
    tools: [payload.failed.tool],
    keywords: [payload.failed.tool],
  }
}

/** Trigger derived from a procedure: match the tool sequence shape. */
export function triggerFromProcedure(payload: ProcedurePayload): SkillTrigger {
  const tools = [...new Set(payload.steps.map(step => step.tool))]
  return {
    tools,
    actionKeys: payload.steps.map(step => procedureStepKey(step.tool, step.args)),
    keywords: tools,
  }
}

/** Trigger for the corrected approach: remember both the failure and the fix. */
export function correctionTrigger(failedActionKey: string, succeededActionKey: string): SkillTrigger {
  return {
    actionKeys: [failedActionKey, succeededActionKey],
    keywords: ['correction'],
  }
}

/** Build a corrected-approach instruction line for a correction experience. */
export function correctedInstruction(payload: CorrectionPayload): string {
  return `Avoid ${payload.failed.tool} step (${payload.failed.args}); use ${payload.succeeded.tool} (${payload.succeeded.args}) instead.`
}

/** Build a procedure-step instruction line. */
export function procedureInstruction(payload: ProcedurePayload, index: number): string {
  const step = payload.steps[index]
  if (step === undefined) return ''
  return `${index + 1}. Run ${step.tool} (${step.args}).`
}

/** Build the exact action key a procedure step would produce at runtime. */
export function procedureStepActionKey(tool: string, rawArgs: string): string {
  return procedureStepKey(tool, rawArgs)
}

/** Build the exact action key a correction's failed step produces. */
export function correctionFailedActionKey(tool: string, rawArgs: string): string {
  return actionKey(tool, rawArgs)
}
