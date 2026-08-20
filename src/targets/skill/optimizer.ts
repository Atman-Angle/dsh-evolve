/**
 * Skill optimizer (v0.2, Target 4 — Skill Optimization).
 *
 * Records skill usage; when usage or corrections show the skill repeatedly
 * misses, produces a CANDIDATE v+1 (never overwrites the active version).
 * Rollback is always available via the version history.
 *
 * @module dsh-evolve/targets/skill/optimizer
 */

import type { CorrectionPayload } from '../../experience/contracts.js'
import { correctedInstruction } from './generator.js'
import type { Skill, SkillDraft, SkillTrigger } from './model.js'

export interface OptimizationResult {
  draft: SkillDraft
  reason: string
}

/**
 * Optimize a skill from correction experiences whose failed step belongs to
 * this skill's trigger: the v+1 draft adds the corrected approach and extends
 * the trigger with the succeeded action key.
 */
export function optimizeFromCorrections(
  skill: Skill,
  corrections: readonly CorrectionPayload[],
): OptimizationResult | undefined {
  if (corrections.length === 0) return undefined
  const current = skill.versions[skill.versions.length - 1]
  if (current === undefined) return undefined
  const trigger: SkillTrigger = {
    actionKeys: [...new Set([
      ...(current.trigger.actionKeys ?? []),
      ...corrections.map(correction => correction.succeeded.actionKey),
    ])],
    tools: [...new Set([...(current.trigger.tools ?? []), ...corrections.map(correction => correction.succeeded.tool)])],
    keywords: [...new Set([...(current.trigger.keywords ?? []), ...corrections.map(correction => correction.succeeded.tool)])],
  }
  const instructions = [
    ...current.instructions,
    ...corrections.map(correctedInstruction),
    'Correction-aware: prefer the corrected approach over the known failing pattern.',
  ]
  return {
    draft: {
      name: skill.name,
      description: current.description,
      trigger,
      instructions,
    },
    reason: `${corrections.length} correction(s) targeted this skill's failing pattern`,
  }
}

/**
 * Optimize a skill from usage outcomes: repeated failures without corrections
 * downgrade the skill to CANDIDATE with a cautionary v+1 (the harness keeps
 * enforcing capability scope regardless).
 */
export function optimizeFromUsage(
  skill: Skill,
  opts: { failureThreshold?: number; usage?: { failures: number; successes: number } } = {},
): OptimizationResult | undefined {
  const current = skill.versions[skill.versions.length - 1]
  if (current === undefined) return undefined
  const threshold = opts.failureThreshold ?? 2
  const usage = opts.usage ?? skill.usage
  const failures = usage.failures
  const successes = usage.successes
  if (failures < threshold || failures <= successes) return undefined
  return {
    draft: {
      name: skill.name,
      description: current.description,
      trigger: current.trigger,
      instructions: [
        ...current.instructions,
        `Caution: ${failures} failures observed against ${successes} successes — verify assumptions before following this procedure.`,
      ],
    },
    reason: `usage shows ${failures} failures vs ${successes} successes`,
  }
}

/** Compose optimization candidates (corrections first, then usage). */
export function proposeOptimization(
  skill: Skill,
  corrections: readonly CorrectionPayload[],
  usage?: { failures: number; successes: number },
): OptimizationResult | undefined {
  return optimizeFromCorrections(skill, corrections)
    ?? optimizeFromUsage(skill, usage === undefined ? {} : { usage })
}
