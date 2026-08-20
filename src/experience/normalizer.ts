/**
 * Experience normalizer (v0.2, spec §7).
 *
 * Turns raw mined signals into canonical summaries and stable dedup keys.
 * The dedup key covers ONLY the identity of a pattern (never counters or free
 * text), so the same regularity observed across different sessions merges
 * while genuinely different patterns stay separate.
 *
 * @module dsh-evolve/experience/normalizer
 */

import { collapseWhitespace, fingerprint } from '../features/hash.js'
import type {
  CandidateExperience,
  CorrectionPayload,
  ExperienceKind,
  ExperiencePayload,
  FactPayload,
  FailurePatternPayload,
  PreferencePayload,
  ProcedurePayload,
} from './contracts.js'

/** Cap for human-readable summaries (keeps L1 records small). */
export const SUMMARY_CAP = 160

/** Normalize arbitrary text into a compact one-liner. */
export function normalizeSummary(text: string, cap = SUMMARY_CAP): string {
  const collapsed = collapseWhitespace(text)
  return collapsed.length <= cap ? collapsed : `${collapsed.slice(0, cap)}…`
}

/** Canonical identity key of a payload — the dedup backbone. */
export function payloadKey(kind: ExperienceKind, payload: ExperiencePayload): string {
  switch (kind) {
    case 'fact': {
      const fact = payload as FactPayload
      return `fact:${fact.scope}:${norm(fact.subject)}:${norm(fact.property)}:${norm(fact.value)}`
    }
    case 'preference': {
      const pref = payload as PreferencePayload
      return `preference:${norm(pref.preference)}:${pref.over === undefined ? '' : norm(pref.over)}`
    }
    case 'correction': {
      const corr = payload as CorrectionPayload
      const failed = corr.failed
      const succeeded = corr.succeeded
      return `correction:${failed.tool}:${failed.actionKey}:${succeeded.tool}:${succeeded.actionKey}`
    }
    case 'successful-procedure': {
      const proc = payload as ProcedurePayload
      const chain = proc.steps.map(step => step.actionKey).join('>')
      return `procedure:${fingerprint(chain)}`
    }
    case 'failure-pattern': {
      const pattern = payload as FailurePatternPayload
      return `failure:${pattern.kind}:${pattern.signature}`
    }
  }
}

function norm(value: string): string {
  return collapseWhitespace(value.toLowerCase())
}

/** Human-readable summary for a payload. */
export function summarizePayload(kind: ExperienceKind, payload: ExperiencePayload): string {
  switch (kind) {
    case 'fact': {
      const fact = payload as FactPayload
      return normalizeSummary(`${fact.subject}.${fact.property} = ${fact.value} (${fact.scope})`)
    }
    case 'preference': {
      const pref = payload as PreferencePayload
      return pref.over === undefined
        ? normalizeSummary(`user prefers ${pref.preference}`)
        : normalizeSummary(`user prefers ${pref.preference} over ${pref.over}`)
    }
    case 'correction': {
      const corr = payload as CorrectionPayload
      return normalizeSummary(
        `${corr.failed.tool} ${corr.failed.args} failed → ${corr.succeeded.tool} ${corr.succeeded.args} succeeded`,
      )
    }
    case 'successful-procedure': {
      const proc = payload as ProcedurePayload
      const chain = proc.steps.map(step => step.tool).join(' → ')
      return normalizeSummary(`procedure: ${chain}`)
    }
    case 'failure-pattern': {
      const pattern = payload as FailurePatternPayload
      return normalizeSummary(`${pattern.description} (x${pattern.repeats})`)
    }
  }
}

/** Build the summary + summaryKey for a mined candidate (idempotent). */
export function finalizeCandidate(candidate: Omit<CandidateExperience, 'summary' | 'summaryKey'>): CandidateExperience {
  return {
    ...candidate,
    summary: summarizePayload(candidate.kind, candidate.payload),
    summaryKey: payloadKey(candidate.kind, candidate.payload),
  }
}
