/**
 * Experience deduplicator + evidence aggregator (v0.2, spec §7).
 *
 * Merges freshly mined candidates into existing stored records by summaryKey:
 * - new key → a DISCOVERED record with 1 occurrence;
 * - existing key → evidence grows (occurrences, success/failure split, session
 *   union) and the record is re-promoted when it crosses evidence thresholds.
 *
 * Pure function — persistence is the store's job.
 *
 * @module dsh-evolve/experience/deduplicator
 */

import { randomUUID } from 'node:crypto'
import { buildEvidence, computeConfidence } from './confidence.js'
import type { CandidateExperience, EvidenceSummary, ExperienceRecord } from './contracts.js'

export interface MergeOutcome {
  /** All records after the merge (existing + new). */
  records: ExperienceRecord[]
  /** Ids created by this merge. */
  created: string[]
  /** Ids updated by this merge. */
  updated: string[]
}

/** Evidence thresholds that promote DISCOVERED → CANDIDATE (conservative). */
export function shouldPromoteToCandidate(record: ExperienceRecord): boolean {
  const evidence = record.evidence
  return evidence.sessions >= 2 && evidence.occurrences >= 3
}

/** Re-evaluate status promotion for one record. */
export function promoteStatus(record: ExperienceRecord): ExperienceRecord {
  if (record.status === 'DISCOVERED' && shouldPromoteToCandidate(record)) {
    return { ...record, status: 'CANDIDATE' }
  }
  return record
}

function newRecord(candidate: CandidateExperience, now: string): ExperienceRecord {
  const evidence: EvidenceSummary = buildEvidence({
    sessions: 1,
    occurrences: 1,
    successfulOccurrences: candidate.outcome === 'failure' ? 0 : 1,
    failedOccurrences: candidate.outcome === 'failure' ? 1 : 0,
  })
  return {
    id: `exp_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    kind: candidate.kind,
    status: 'DISCOVERED',
    summary: candidate.summary,
    summaryKey: candidate.summaryKey,
    createdAt: now,
    updatedAt: now,
    sessionIds: [candidate.sessionId],
    evidence,
    compatibility: candidate.compatibility,
    provenance: { origin: { local: true }, version: 1 },
    payload: candidate.payload,
  }
}

function mergeInto(existing: ExperienceRecord, candidate: CandidateExperience, now: string): ExperienceRecord {
  const sessions = new Set(existing.sessionIds)
  sessions.add(candidate.sessionId)
  const evidence: EvidenceSummary = {
    sessions: sessions.size,
    occurrences: existing.evidence.occurrences + 1,
    successfulOccurrences: existing.evidence.successfulOccurrences + (candidate.outcome === 'failure' ? 0 : 1),
    failedOccurrences: existing.evidence.failedOccurrences + (candidate.outcome === 'failure' ? 1 : 0),
    confidence: 0, // recomputed below
  }
  return {
    ...existing,
    updatedAt: now,
    sessionIds: [...sessions].sort(),
    evidence: {
      ...evidence,
      confidence: computeConfidence(evidence),
    },
  }
}

/**
 * Merge candidates into existing records.
 * @param existing - current persisted records (read fresh by the caller).
 * @param candidates - newly mined candidates (any session).
 * @param now - ISO timestamp for the merge.
 */
export function mergeCandidates(
  existing: readonly ExperienceRecord[],
  candidates: readonly CandidateExperience[],
  now: string,
): MergeOutcome {
  const byKey = new Map<string, ExperienceRecord>()
  for (const record of existing) byKey.set(record.summaryKey, record)

  const created: string[] = []
  const updated: string[] = []
  for (const candidate of candidates) {
    const current = byKey.get(candidate.summaryKey)
    if (current === undefined) {
      const record = promoteStatus(newRecord(candidate, now))
      byKey.set(candidate.summaryKey, record)
      created.push(record.id)
    } else {
      const merged = promoteStatus(mergeInto(current, candidate, now))
      byKey.set(candidate.summaryKey, merged)
      updated.push(merged.id)
    }
  }
  const records = [...byKey.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  return { records, created, updated }
}
