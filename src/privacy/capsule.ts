/**
 * L2 Experience Capsule (v0.2, spec §4, §16, §19).
 *
 * The shareable, structured, privacy-compiled unit that MAY travel to the
 * Commons. Capsules never contain raw sessions, prompts, code, or free text —
 * only schema-defined structured fields and hash-based signatures.
 *
 * @module dsh-evolve/privacy/capsule
 */

import { fingerprint } from '../features/hash.js'

export type CapsuleKind = 'fact' | 'correction' | 'procedural' | 'failure-pattern'

export interface ExperienceCapsule {
  schema: 'evolve/v1'
  kind: CapsuleKind
  /** Structured applicability (never free text). */
  appliesTo: {
    domain?: string
    language?: string
  }
  /** Structured trigger (hash-based action keys only). */
  trigger: Record<string, unknown>
  /** Schema-defined action enum (spec §16). */
  recommendedAction?: string
  evidence: {
    supportBucket: string
    outcomeDirection: 'positive' | 'negative' | 'neutral'
  }
  privacy: {
    rawSession: false
    freeText: false
  }
  /** Sanitized one-liner generated from structured fields only. */
  summary: string
  /** Content hash over the canonical capsule JSON (verification identity). */
  hash: string
  /** Local traceability — NOT uploaded (stripped by contribution). */
  sourceExperienceId: string
  createdAt: string
}

/** Bucket the support count into the spec's coarse buckets. */
export function supportBucket(occurrences: number): string {
  if (occurrences >= 10) return '10+'
  if (occurrences >= 5) return '5-10'
  if (occurrences >= 3) return '3-5'
  return '1-2'
}

/** Direction of the evidence (positive = more successes than failures). */
export function outcomeDirection(successful: number, failed: number): 'positive' | 'negative' | 'neutral' {
  if (successful > failed) return 'positive'
  if (failed > successful) return 'negative'
  return 'neutral'
}

/** Compute the canonical content hash of a capsule. */
export function capsuleHash(capsule: Omit<ExperienceCapsule, 'hash'>): string {
  return fingerprint(JSON.stringify(capsule))
}

/** Human-readable preview of a capsule (for `capsule preview` / contribution). */
export function renderCapsulePreview(capsule: ExperienceCapsule): string {
  const lines = [
    `schema:          ${capsule.schema}`,
    `kind:            ${capsule.kind}`,
    `summary:         ${capsule.summary}`,
    `appliesTo:       ${JSON.stringify(capsule.appliesTo)}`,
    `trigger:         ${JSON.stringify(capsule.trigger)}`,
    ...(capsule.recommendedAction === undefined ? [] : [`recommendedAction: ${capsule.recommendedAction}`]),
    `evidence:        support=${capsule.evidence.supportBucket} direction=${capsule.evidence.outcomeDirection}`,
    `privacy:         rawSession=${capsule.privacy.rawSession} freeText=${capsule.privacy.freeText}`,
    `hash:            ${capsule.hash}`,
  ]
  return lines.join('\n')
}
