/**
 * Mutation registry (v0.2, spec §8, §11).
 *
 * Persists proposals with their full lifecycle: DISCOVERED → CANDIDATE →
 * VALIDATING → ACTIVE → DEPRECATED → REJECTED, plus an append-only transition
 * history so every ACTIVE mutation can answer: why, from which experience,
 * when, which version, and how to roll back.
 *
 * @module dsh-evolve/mutation/registry
 */

import { JsonlStore } from '../storage/jsonl-store.js'
import type { Gate } from './contracts.js'
import type { MutationProposal, MutationStatus } from './contracts.js'

export interface TransitionLog {
  from: MutationStatus | 'NEW'
  to: MutationStatus
  at: string
  reason?: string
}

/** A proposal plus its immutable transition history. */
export type StoredProposal = MutationProposal & { history: TransitionLog[] }

const LEGAL: Record<MutationStatus, readonly MutationStatus[]> = {
  DISCOVERED: ['CANDIDATE', 'REJECTED'],
  CANDIDATE: ['VALIDATING', 'ACTIVE', 'REJECTED'],
  VALIDATING: ['CANDIDATE', 'ACTIVE', 'REJECTED'],
  ACTIVE: ['DEPRECATED', 'CANDIDATE'],
  DEPRECATED: ['REJECTED'],
  REJECTED: [],
}

export function legalTransition(from: MutationStatus, to: MutationStatus): boolean {
  return LEGAL[from].includes(to)
}

export class MutationRegistry {
  private readonly store: JsonlStore<StoredProposal>

  constructor(root: string) {
    this.store = new JsonlStore(root, 'mutations/proposals.jsonl')
  }

  /** Register proposals (planner output): new ones are stored, existing ones
   * get their evidence refreshed (the proposal id is deterministic). */
  async register(proposals: readonly MutationProposal[], now = new Date().toISOString()): Promise<string[]> {
    const existing = await this.store.read()
    const byId = new Map(existing.map(proposal => [proposal.id, proposal]))
    const created: string[] = []
    for (const proposal of proposals) {
      const current = byId.get(proposal.id)
      if (current === undefined) {
        const stored: StoredProposal = {
          ...proposal,
          history: [{ from: 'NEW', to: proposal.status, at: now }],
        }
        byId.set(proposal.id, stored)
        created.push(proposal.id)
      } else if (proposal.evidence.occurrences > current.evidence.occurrences) {
        byId.set(proposal.id, {
          ...current,
          evidence: proposal.evidence,
          updatedAt: now,
          sourceExperienceIds: [...new Set([...current.sourceExperienceIds, ...proposal.sourceExperienceIds])],
        })
      }
    }
    await this.store.replaceAll([...byId.values()])
    return created
  }

  async list(): Promise<StoredProposal[]> {
    const records = await this.store.read()
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listByTarget(target: string): Promise<StoredProposal[]> {
    return (await this.list()).filter(proposal => proposal.target === target)
  }

  async listByStatus(status: MutationStatus): Promise<StoredProposal[]> {
    return (await this.list()).filter(proposal => proposal.status === status)
  }

  async getById(id: string): Promise<StoredProposal | undefined> {
    return (await this.store.read()).find(proposal => proposal.id === id)
  }

  /** Apply a transition (illegal transitions throw). */
  async transition(id: string, to: MutationStatus, reason?: string, now = new Date().toISOString()): Promise<StoredProposal> {
    return this.store.update(id, proposal => {
      if (!legalTransition(proposal.status, to)) {
        throw new Error(`dsh-evolve: illegal mutation transition ${proposal.status} → ${to} (${id})`)
      }
      return {
        ...proposal,
        status: to,
        updatedAt: now,
        history: [...proposal.history, { from: proposal.status, to, at: now, ...(reason === undefined ? {} : { reason }) }],
      }
    }).then(updated => {
      if (updated === undefined) throw new Error(`dsh-evolve: unknown mutation ${id}`)
      return updated
    })
  }

  /**
   * Promote a proposal to ACTIVE, honoring its gate. Higher-risk gates require
   * validationPassed and an explicit approver ('auto' | 'user' | 'policy').
   */
  async promote(
    id: string,
    opts: { gate: Gate; validationPassed: boolean; approver: 'auto' | 'user' | 'policy'; reason?: string },
    now = new Date().toISOString(),
  ): Promise<StoredProposal> {
    return this.store.update(id, proposal => {
      if (proposal.status === 'ACTIVE') return proposal
      // Legal promotion preconditions: auto gates may promote straight from
      // DISCOVERED; everything else must have cleared CANDIDATE/VALIDATING.
      const promotable =
        proposal.status === 'CANDIDATE' || proposal.status === 'VALIDATING'
        || ((opts.gate === 'auto' || opts.gate === 'auto-visible') && proposal.status === 'DISCOVERED')
      if (!promotable) {
        throw new Error(`dsh-evolve: cannot promote ${id}: status ${proposal.status} is not promotable`)
      }
      if (opts.gate === 'confirm' && opts.approver === 'auto') {
        throw new Error(`dsh-evolve: cannot promote ${id}: confirm gate requires a human decision`)
      }
      const gateSatisfied =
        opts.gate === 'auto' || opts.gate === 'auto-visible'
          ? true
          : opts.validationPassed && opts.approver !== 'auto'
      if (!gateSatisfied) {
        throw new Error(
          `dsh-evolve: cannot promote ${id}: gate ${opts.gate} requires validation + ${opts.gate === 'confirm' ? 'human' : 'policy'} approval`,
        )
      }
      return {
        ...proposal,
        status: 'ACTIVE',
        activatedAt: now,
        version: proposal.version + 1,
        updatedAt: now,
        history: [
          ...proposal.history,
          { from: proposal.status, to: 'ACTIVE', at: now, reason: opts.reason ?? `gate ${opts.gate} (${opts.approver})` },
        ],
      }
    }).then(updated => {
      if (updated === undefined) throw new Error(`dsh-evolve: unknown mutation ${id}`)
      return updated
    })
  }

  /** Reject (terminal) or deprecate (reversible) a proposal. */
  async reject(id: string, reason: string): Promise<StoredProposal> {
    return this.transition(id, 'REJECTED', reason)
  }

  async deprecate(id: string, reason: string): Promise<StoredProposal> {
    return this.transition(id, 'DEPRECATED', reason)
  }

  /** Roll an ACTIVE mutation back to CANDIDATE (version bump, traceable). */
  async rollback(id: string, reason: string, now = new Date().toISOString()): Promise<StoredProposal> {
    return this.store.update(id, proposal => {
      if (proposal.status !== 'ACTIVE') {
        throw new Error(`dsh-evolve: cannot roll back ${id}: status is ${proposal.status}`)
      }
      return {
        ...proposal,
        status: 'CANDIDATE',
        version: proposal.version + 1,
        updatedAt: now,
        history: [
          ...proposal.history,
          { from: 'ACTIVE', to: 'CANDIDATE', at: now, reason: `rollback: ${reason}` },
        ],
      }
    }).then(updated => {
      if (updated === undefined) throw new Error(`dsh-evolve: unknown mutation ${id}`)
      return updated
    })
  }

  /** Status counts (for the status CLI). */
  async aggregate(): Promise<{ status: Record<string, number>; target: Record<string, number>; total: number }> {
    const records = await this.store.read()
    const status: Record<string, number> = {}
    const target: Record<string, number> = {}
    for (const proposal of records) {
      status[proposal.status] = (status[proposal.status] ?? 0) + 1
      target[proposal.target] = (target[proposal.target] ?? 0) + 1
    }
    return { status, target, total: records.length }
  }
}
