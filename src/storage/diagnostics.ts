/**
 * Diagnostics log (v0.2 release hardening).
 *
 * Every non-fatal evolve failure is recorded here (capability, error, context,
 * timestamp) so the system can "disable affected capability → record
 * diagnostic → continue vanilla DSH". The log is bounded: only recent entries
 * are kept on disk.
 *
 * @module dsh-evolve/storage/diagnostics
 */

import { JsonlStore } from './jsonl-store.js'

export interface DiagnosticEntry {
  id: string
  at: string
  /** Capability affected (e.g. semantic-miner, commons, store, privacy). */
  capability: string
  error: string
  context?: string
}

const MAX_ENTRIES = 200

export class DiagnosticLog {
  private readonly store: JsonlStore<DiagnosticEntry>

  constructor(root: string) {
    this.store = new JsonlStore(root, 'diagnostics/diagnostics.jsonl')
  }

  async record(capability: string, error: unknown, context?: string): Promise<void> {
    try {
      const entry: DiagnosticEntry = {
        id: `diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        capability,
        error: (error as Error | null)?.message ?? String(error).slice(0, 500),
        ...(context === undefined ? {} : { context }),
      }
      const records = await this.store.read()
      records.push(entry)
      const trimmed = records.slice(-MAX_ENTRIES)
      await this.store.replaceAll(trimmed)
    } catch {
      // The diagnostics sink itself must never throw into the agent path.
    }
  }

  async list(limit = 50): Promise<DiagnosticEntry[]> {
    const records = await this.store.read()
    return records.slice(-limit).reverse()
  }

  async count(): Promise<number> {
    return (await this.store.read()).length
  }
}
