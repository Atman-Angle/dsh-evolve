/**
 * Community matcher (v0.2, spec §23 — Local Matcher).
 *
 * Matches a current task context against downloaded community capsules.
 * Compatibility (language/domain) is checked first; remote content is a
 * candidate prior — it enters SHADOW, never the prompt directly.
 *
 * @module dsh-evolve/commons/matcher
 */

import type { ExperienceCapsule } from '../privacy/capsule.js'
import type { TaskContext } from '../targets/skill-routing/store.js'
import { taskKeywords } from '../targets/skill-routing/store.js'

export interface CommunityMatch {
  capsule: ExperienceCapsule
  score: number
  reasons: string[]
}

/** Compatibility: capsule appliesTo must not contradict the context. */
export function compatible(capsule: ExperienceCapsule, context: TaskContext): boolean {
  const appliesTo = capsule.appliesTo
  if (context.language !== undefined && appliesTo.language !== undefined && context.language !== appliesTo.language) {
    return false
  }
  if (context.domain !== undefined && appliesTo.domain !== undefined && context.domain !== appliesTo.domain) {
    return false
  }
  return true
}

/** Collect all string values from a structured trigger (for scoring). */
function triggerStrings(trigger: Record<string, unknown>): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) walk((value as Record<string, unknown>)[key])
    }
  }
  walk(trigger)
  return out
}

/** Score one capsule against a task context (pure). */
export function matchCapsule(capsule: ExperienceCapsule, context: TaskContext): CommunityMatch | undefined {
  if (!compatible(capsule, context)) return undefined
  const keywords = new Set(taskKeywords(context.text))
  const tools = new Set(context.tools ?? [])
  const reasons: string[] = []
  let hits = 0

  for (const value of triggerStrings(capsule.trigger)) {
    const lower = value.toLowerCase()
    if (keywords.has(lower)) {
      hits += 1
      reasons.push(`keyword:${lower}`)
    }
    if (tools.has(lower)) {
      hits += 1
      reasons.push(`tool:${lower}`)
    }
  }
  if (capsule.trigger['kind'] === 'failure-pattern' && (context.text ?? '').toLowerCase().includes('error')) {
    hits += 1
    reasons.push('error-context')
  }
  if (hits === 0) return undefined
  const score = Math.min(1, hits / 3) // saturate quickly; 3 hits = full match
  return { capsule, score: Math.round(score * 1000) / 1000, reasons }
}

/** Rank matching capsules for a task context. */
export function matchCapsules(capsules: readonly ExperienceCapsule[], context: TaskContext): CommunityMatch[] {
  return capsules
    .map(capsule => matchCapsule(capsule, context))
    .filter((match): match is CommunityMatch => match !== undefined)
    .sort((a, b) => b.score - a.score)
}

export interface TaskContextWithCompatibility extends TaskContext {
  language?: string
  domain?: string
}
