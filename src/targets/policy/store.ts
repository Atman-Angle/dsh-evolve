/**
 * Policy targets (v0.2, Targets 7/8 — Context / Tool / Runtime Policy,
 * risks 4/5).
 *
 * Policies change harness-level knobs (tool surface, context retention,
 * strategy reset, model escalation). They are the highest-risk evolution
 * targets: promotion requires eval (+ shadow + rollback for runtime).
 *
 * Runtime Evolution Example #1 — stuck-reset — is modeled here as an ACTIVE
 * runtime-policy record referencing the v0.1 recipe (`reset-v1`); the actual
 * intervention machinery lives in the preserved v0.1 module.
 *
 * @module dsh-evolve/targets/policy
 */

import { JsonlStore } from '../../storage/jsonl-store.js'
import type { AllowedAction } from '../../contracts/actions.js'
import type { ExperienceStatus } from '../../experience/contracts.js'
import type { MutationProposal } from '../../mutation/contracts.js'

export type PolicyKind = 'context' | 'tool' | 'runtime'

export interface PolicyRecord {
  id: string
  kind: PolicyKind
  action: AllowedAction
  enabled: boolean
  status: ExperienceStatus
  sourceMutationId?: string
  /** For runtime policies that map onto an existing v0.1 recipe. */
  recipeId?: string
  evidence: {
    sessions: number
    occurrences: number
    confidence: number
  }
  createdAt: string
  updatedAt: string
}

const KIND_FILE: Record<PolicyKind, string> = {
  context: 'policies/context.jsonl',
  tool: 'policies/tool.jsonl',
  runtime: 'policies/runtime.jsonl',
}

/** v0.1 recipe mapping for runtime actions (Runtime Evolution Example #1). */
export const RUNTIME_ACTION_RECIPE: Partial<Record<AllowedAction, string>> = {
  STRATEGY_RESET: 'reset-v1',
}

export class PolicyStore {
  private readonly stores: Record<PolicyKind, JsonlStore<PolicyRecord>>

  constructor(root: string) {
    this.stores = {
      context: new JsonlStore(root, KIND_FILE.context),
      tool: new JsonlStore(root, KIND_FILE.tool),
      runtime: new JsonlStore(root, KIND_FILE.runtime),
    }
  }

  async list(kind?: PolicyKind): Promise<PolicyRecord[]> {
    const kinds: PolicyKind[] = kind === undefined ? ['context', 'tool', 'runtime'] : [kind]
    const records: PolicyRecord[] = []
    for (const entry of kinds) records.push(...await this.stores[entry].read())
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listEnabled(kind?: PolicyKind): Promise<PolicyRecord[]> {
    return (await this.list(kind)).filter(record => record.enabled && record.status === 'ACTIVE')
  }

  async getById(id: string): Promise<PolicyRecord | undefined> {
    for (const kind of ['context', 'tool', 'runtime'] as const) {
      const record = (await this.stores[kind].read()).find(entry => entry.id === id)
      if (record !== undefined) return record
    }
    return undefined
  }

  /** Create a policy record from a policy mutation proposal (not yet active). */
  async fromProposal(proposal: MutationProposal, now = new Date().toISOString()): Promise<PolicyRecord> {
    const change = proposal.proposedChange as { kind?: string; pattern?: { recommendedAction?: string } } | undefined
    const action = change?.pattern?.recommendedAction
    const kind: PolicyKind = proposal.target === 'context-policy' ? 'context'
      : proposal.target === 'tool-policy' ? 'tool' : 'runtime'
    if (action === undefined || action === '') {
      throw new Error(`dsh-evolve: policy proposal ${proposal.id} carries no recommendedAction`)
    }
    const record: PolicyRecord = {
      id: `policy_${proposal.id}`,
      kind,
      action: action as AllowedAction,
      enabled: false,
      status: 'DISCOVERED',
      sourceMutationId: proposal.id,
      ...(kind === 'runtime' && RUNTIME_ACTION_RECIPE[action as AllowedAction] !== undefined
        ? { recipeId: RUNTIME_ACTION_RECIPE[action as AllowedAction] }
        : {}),
      evidence: {
        sessions: proposal.evidence.sessions,
        occurrences: proposal.evidence.occurrences,
        confidence: proposal.evidence.confidence,
      },
      createdAt: now,
      updatedAt: now,
    }
    await this.stores[kind].append(record)
    return record
  }

  async setStatus(id: string, status: ExperienceStatus, enabled?: boolean): Promise<PolicyRecord | undefined> {
    for (const kind of ['context', 'tool', 'runtime'] as const) {
      const updated = await this.stores[kind].update(id, record => ({
        ...record,
        status,
        ...(enabled === undefined ? {} : { enabled }),
        updatedAt: new Date().toISOString(),
      }))
      if (updated !== undefined) return updated
    }
    return undefined
  }

  /** The active runtime recipe id (what v0.1 policy resolution should use). */
  async activeRuntimeRecipe(): Promise<string | undefined> {
    const runtime = await this.listEnabled('runtime')
    const withRecipe = runtime.find(record => record.recipeId !== undefined)
    return withRecipe?.recipeId
  }
}
