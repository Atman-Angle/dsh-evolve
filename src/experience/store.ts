/**
 * Experience store (v0.2, spec §7 — Experience Store stage).
 *
 * Persists L1 private experiences under `<root>/experiences/experiences.jsonl`.
 * New candidates are merged through the deduplicator (dedup + evidence
 * aggregation + confidence) before the file is atomically replaced.
 *
 * @module dsh-evolve/experience/store
 */

import { JsonlStore } from '../storage/jsonl-store.js'
import { mergeCandidates } from './deduplicator.js'
import type { CandidateExperience, ExperienceKind, ExperienceRecord, ExperienceStatus } from './contracts.js'

export class ExperienceStore {
  private readonly store: JsonlStore<ExperienceRecord>

  constructor(root: string) {
    this.store = new JsonlStore(root, joinRelative('experiences', 'experiences.jsonl'))
  }

  /** Persist mined candidates (dedup + aggregate). Returns merge outcome ids. */
  async merge(candidates: readonly CandidateExperience[], now = new Date().toISOString()): Promise<{ created: string[]; updated: string[] }> {
    const existing = await this.store.read()
    const outcome = mergeCandidates(existing, candidates, now)
    await this.store.replaceAll(outcome.records)
    return { created: outcome.created, updated: outcome.updated }
  }

  /** All records, newest-updated first. */
  async list(): Promise<ExperienceRecord[]> {
    const records = await this.store.read()
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listByKind(kind: ExperienceKind): Promise<ExperienceRecord[]> {
    return (await this.list()).filter(record => record.kind === kind)
  }

  async listByStatus(status: ExperienceStatus): Promise<ExperienceRecord[]> {
    return (await this.list()).filter(record => record.status === status)
  }

  async getById(id: string): Promise<ExperienceRecord | undefined> {
    return (await this.store.read()).find(record => record.id === id)
  }

  async setStatus(id: string, status: ExperienceStatus): Promise<ExperienceRecord | undefined> {
    return this.store.update(id, record => ({ ...record, status, updatedAt: new Date().toISOString() }))
  }

  /** Record the outcome of a temporary retrieval without activating anything. */
  async recordRetrievalOutcome(id: string, outcome: 'positive' | 'negative' | 'neutral'): Promise<ExperienceRecord | undefined> {
    return this.store.update(id, record => {
      if (outcome === 'neutral') return record
      const delta = outcome === 'positive' ? 0.05 : -0.1
      const confidence = Math.round(Math.min(1, Math.max(0, record.evidence.confidence + delta)) * 1000) / 1000
      return { ...record, evidence: { ...record.evidence, confidence }, updatedAt: new Date().toISOString() }
    })
  }

  /** Counts per kind/status (for the status CLI and reports). */
  async aggregate(): Promise<{ kind: Record<string, number>; status: Record<string, number>; total: number }> {
    const records = await this.store.read()
    const kind: Record<string, number> = {}
    const status: Record<string, number> = {}
    for (const record of records) {
      kind[record.kind] = (kind[record.kind] ?? 0) + 1
      status[record.status] = (status[record.status] ?? 0) + 1
    }
    return { kind, status, total: records.length }
  }
}

function joinRelative(...parts: string[]): string {
  return parts.join('/')
}
