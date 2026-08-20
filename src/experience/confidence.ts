/**
 * Evidence aggregation and confidence calculation (v0.2, spec §3.3, §7).
 *
 * Confidence is deliberately conservative and monotone in support:
 *
 *   confidence = successRate × supportFactor × sessionFactor
 *
 * - successRate: smoothed success share of occurrences.
 * - supportFactor: ramps from 0→1 as occurrences approach `minSupport`.
 * - sessionFactor: requires evidence to come from more than one session.
 *
 * All inputs are counts; the function is pure and replayable.
 *
 * @module dsh-evolve/experience/confidence
 */

import type { EvidenceSummary } from './contracts.js'

export interface EvidenceInput {
  sessions: number
  occurrences: number
  successfulOccurrences: number
  failedOccurrences: number
  /** Occurrences needed to reach full support (default 3). */
  minSupport?: number
  /** Sessions needed to reach full session credit (default 2). */
  minSessions?: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** The confidence formula itself (exposed for eval/sweep tooling). */
export function computeConfidence(input: EvidenceInput): number {
  const { sessions, occurrences, successfulOccurrences, failedOccurrences } = input
  const minSupport = input.minSupport ?? 3
  const minSessions = input.minSessions ?? 2
  if (occurrences <= 0) return 0
  const successRate = (successfulOccurrences + 0.5) / (occurrences + 1)
  const supportFactor = clamp01(occurrences / minSupport)
  const sessionFactor = clamp01(sessions / minSessions)
  const confidence = successRate * supportFactor * sessionFactor
  return Math.round(clamp01(confidence) * 1000) / 1000
}

/** Build a full EvidenceSummary from raw counts. */
export function buildEvidence(input: EvidenceInput): EvidenceSummary {
  return {
    sessions: input.sessions,
    occurrences: input.occurrences,
    successfulOccurrences: input.successfulOccurrences,
    failedOccurrences: input.failedOccurrences,
    confidence: computeConfidence(input),
  }
}

/** Increment evidence for one more occurrence of a pattern. */
export function addOccurrence(
  evidence: EvidenceSummary,
  occurrence: { outcome: 'success' | 'failure' | 'neutral'; sessionId: string; sessions: string[] },
): EvidenceSummary {
  const sessions = new Set(occurrence.sessions)
  sessions.add(occurrence.sessionId)
  const successful = evidence.successfulOccurrences + (occurrence.outcome === 'failure' ? 0 : 1)
  const failed = evidence.failedOccurrences + (occurrence.outcome === 'failure' ? 1 : 0)
  return buildEvidence({
    sessions: sessions.size,
    occurrences: evidence.occurrences + 1,
    successfulOccurrences: successful,
    failedOccurrences: failed,
  })
}

/** Zero-evidence placeholder (for freshly created records). */
export function emptyEvidence(): EvidenceSummary {
  return buildEvidence({ sessions: 0, occurrences: 0, successfulOccurrences: 0, failedOccurrences: 0 })
}
