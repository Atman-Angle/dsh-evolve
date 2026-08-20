/**
 * Memory target (v0.2, Target 1 — Memory, risk 0, auto-activatable).
 *
 * Project/environment facts learned from real usage (e.g. `package-manager =
 * pnpm`, `test-command = pnpm test`). Facts are read-only at runtime and can be
 * surfaced to the agent's context; they never change the harness.
 *
 * @module dsh-evolve/targets/memory
 */

import { JsonlStore, assertSafeStoreId } from '../../storage/jsonl-store.js'
import type { FactPayload } from '../../experience/contracts.js'

export type MemoryStatus = 'DISCOVERED' | 'ACTIVE' | 'DEPRECATED' | 'REJECTED'

export interface MemoryFact {
  id: string
  fact: FactPayload
  status: MemoryStatus
  /** Mutation proposal that activated this fact. */
  sourceMutationId?: string
  createdAt: string
  updatedAt: string
}

export class MemoryStore {
  private readonly store: JsonlStore<MemoryFact>

  constructor(root: string) {
    this.store = new JsonlStore(root, 'memory/facts.jsonl')
  }

  async list(): Promise<MemoryFact[]> {
    return (await this.store.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Facts eligible for runtime context assembly. */
  async listActive(): Promise<MemoryFact[]> {
    return (await this.list()).filter(fact => fact.status === 'ACTIVE')
  }

  async getById(id: string): Promise<MemoryFact | undefined> {
    return (await this.store.read()).find(fact => fact.id === id)
  }

  /** Upsert a fact by its identity key (subject/property/scope). */
  async upsert(
    fact: FactPayload,
    opts: { id?: string; sourceMutationId?: string; status?: MemoryStatus; now?: string } = {},
  ): Promise<MemoryFact> {
    const now = opts.now ?? new Date().toISOString()
    const records = await this.store.read()
    const existing = records.find(record =>
      record.fact.subject === fact.subject
      && record.fact.property === fact.property
      && record.fact.scope === fact.scope
    )
    if (existing !== undefined) {
      const updated: MemoryFact = {
        ...existing,
        fact,
        status: opts.status ?? existing.status,
        ...(opts.sourceMutationId === undefined ? {} : { sourceMutationId: opts.sourceMutationId }),
        updatedAt: now,
      }
      await this.store.replaceAll(records.map(record => record.id === existing.id ? updated : record))
      return updated
    }
    const created: MemoryFact = {
      id: opts.id ?? `mem_${now.replaceAll(/[^0-9a-z]/gi, '').slice(0, 14)}`,
      fact,
      status: opts.status ?? 'DISCOVERED',
      ...(opts.sourceMutationId === undefined ? {} : { sourceMutationId: opts.sourceMutationId }),
      createdAt: now,
      updatedAt: now,
    }
    assertSafeStoreId(created.id, 'memory id')
    await this.store.append(created)
    return created
  }

  async setStatus(id: string, status: MemoryStatus): Promise<MemoryFact | undefined> {
    return this.store.update(id, record => ({ ...record, status, updatedAt: new Date().toISOString() }))
  }
}
