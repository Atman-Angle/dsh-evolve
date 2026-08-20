/**
 * Workflow recipe target (v0.2, Target 6 — Workflow Recipe, risk 2).
 *
 * Recipes encode task ORGANIZATION ("when to do what"), distinct from skills
 * ("how to do it"). A recipe is a phase list (inspect → plan → execute →
 * validate → final validate). Recipes activate after shadow validation.
 *
 * @module dsh-evolve/targets/recipe
 */

import { JsonlStore } from '../../storage/jsonl-store.js'
import type { MutationProposal } from '../../mutation/contracts.js'
import type { EvidenceSummary, ExperienceStatus } from '../../experience/contracts.js'

export interface WorkflowRecipe {
  id: string
  name: string
  /** Ordered task phases (tool/activity labels). */
  phases: string[]
  sourceExperienceIds: string[]
  status: ExperienceStatus
  evidence: EvidenceSummary
  sourceMutationId?: string
  version: number
  createdAt: string
  updatedAt: string
}

export class RecipeStore {
  private readonly store: JsonlStore<WorkflowRecipe>

  constructor(root: string) {
    this.store = new JsonlStore(root, 'recipes/workflow.jsonl')
  }

  async list(): Promise<WorkflowRecipe[]> {
    return (await this.store.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listActive(): Promise<WorkflowRecipe[]> {
    return (await this.list()).filter(recipe => recipe.status === 'ACTIVE')
  }

  async getById(id: string): Promise<WorkflowRecipe | undefined> {
    return (await this.store.read()).find(recipe => recipe.id === id)
  }

  /** Create (or refresh) a recipe from a recipe mutation proposal. */
  async fromProposal(proposal: MutationProposal, now = new Date().toISOString()): Promise<WorkflowRecipe> {
    const change = proposal.proposedChange as { kind?: string; phases?: string[] } | undefined
    const phases = change?.kind === 'workflow-recipe' ? (change.phases ?? []) : []
    const existing = await this.getById(`recipe_${proposal.id}`)
    if (existing !== undefined) {
      const updated: WorkflowRecipe = {
        ...existing,
        phases: phases.length > 0 ? phases : existing.phases,
        evidence: proposal.evidence,
        sourceExperienceIds: [...new Set([...existing.sourceExperienceIds, ...proposal.sourceExperienceIds])],
        updatedAt: now,
      }
      await this.replaceById(existing.id, updated)
      return updated
    }
    const recipe: WorkflowRecipe = {
      id: `recipe_${proposal.id}`,
      name: `workflow-${proposal.id}`,
      phases,
      sourceExperienceIds: proposal.sourceExperienceIds,
      status: 'DISCOVERED',
      evidence: proposal.evidence,
      sourceMutationId: proposal.id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.append(recipe)
    return recipe
  }

  private async replaceById(id: string, recipe: WorkflowRecipe): Promise<void> {
    const records = await this.store.read()
    await this.store.replaceAll(records.map(record => record.id === id ? recipe : record))
  }

  async setStatus(id: string, status: ExperienceStatus): Promise<WorkflowRecipe | undefined> {
    return this.store.update(id, recipe => ({ ...recipe, status, updatedAt: new Date().toISOString() }))
  }
}
