/**
 * Skill store (v0.2, Targets 3/4).
 *
 * Persists the skill index (with immutable version history) under
 * `<root>/skills/skills.jsonl` and materializes agent-visible skill bodies
 * under `<root>/skills/active/<id>.json` — the ONLY directory the agent
 * context may read (spec §17). Activation/deactivation syncs the two.
 *
 * @module dsh-evolve/targets/skill/store
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSafeStoreId, JsonlStore } from '../../storage/jsonl-store.js'
import { isAgentVisible, legalSkillTransition } from './model.js'
import type { Skill, SkillDraft, SkillStatus, SkillVersion } from './model.js'
import type { EvidenceSummary } from '../../experience/contracts.js'

/** Validate a store id before it flows into a file name (no traversal). */
function assertSafeId(id: string): void {
  assertSafeStoreId(id, 'skill id')
}

export class SkillStore {
  private readonly store: JsonlStore<Skill>
  private readonly activeDir: string

  constructor(root: string) {
    this.store = new JsonlStore(root, 'skills/skills.jsonl')
    this.activeDir = join(root, 'skills', 'active')
  }

  async list(): Promise<Skill[]> {
    return (await this.store.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listByStatus(status: SkillStatus): Promise<Skill[]> {
    return (await this.list()).filter(skill => skill.status === status)
  }

  /** Only agent-visible skills (spec §17: active/). */
  async listActive(): Promise<Skill[]> {
    return (await this.list()).filter(skill => isAgentVisible(skill.status))
  }

  async getById(id: string): Promise<Skill | undefined> {
    return (await this.store.read()).find(skill => skill.id === id)
  }

  /** Create a local candidate skill from a draft (status CANDIDATE, v1). */
  async createCandidate(
    draft: SkillDraft,
    opts: {
      id?: string
      source: 'local' | 'generated' | 'community'
      experienceIds: string[]
      evidence: EvidenceSummary
      mutationId?: string
      now?: string
    },
  ): Promise<Skill> {
    const now = opts.now ?? new Date().toISOString()
    const id = opts.id ?? `sk_${now.replaceAll(/[^0-9a-z]/gi, '').slice(0, 14)}`
    assertSafeId(id)
    const version: SkillVersion = {
      version: 1,
      description: draft.description,
      instructions: draft.instructions,
      trigger: draft.trigger,
      createdAt: now,
      createdFrom: {
        experienceIds: opts.experienceIds,
        ...(opts.mutationId === undefined ? {} : { mutationId: opts.mutationId }),
      },
      evidence: opts.evidence,
    }
    const skill: Skill = {
      id,
      name: draft.name,
      status: opts.source === 'community' ? 'QUARANTINED' : 'CANDIDATE',
      source: opts.source,
      currentVersion: 1,
      versions: [version],
      usage: { activations: 0, successes: 0, failures: 0 },
      provenance: { origin: { local: true } },
      createdAt: now,
      updatedAt: now,
    }
    await this.store.append(skill)
    return skill
  }

  /** Transition a skill's status with legal-chain enforcement. */
  async transition(id: string, to: SkillStatus, now = new Date().toISOString()): Promise<Skill> {
    const updated = await this.store.update(id, skill => {
      if (!legalSkillTransition(skill.status, to)) {
        throw new Error(`dsh-evolve: illegal skill transition ${skill.status} → ${to} (${id})`)
      }
      return { ...skill, status: to, updatedAt: now }
    })
    if (updated === undefined) throw new Error(`dsh-evolve: unknown skill ${id}`)
    await this.syncActiveBody(updated)
    return updated
  }

  /**
   * Add a new candidate version (v+1) derived from usage evidence. The skill
   * moves to CANDIDATE; the previous version remains in history for rollback.
   */
  async addCandidateVersion(
    id: string,
    opts: {
      description: string
      instructions: string[]
      trigger: SkillDraft['trigger']
      experienceIds: string[]
      evidence: EvidenceSummary
      mutationId?: string
      now?: string
    },
  ): Promise<Skill> {
    const now = opts.now ?? new Date().toISOString()
    const updated = await this.store.update(id, skill => {
      const nextVersion = skill.currentVersion + 1
      const version: SkillVersion = {
        version: nextVersion,
        description: opts.description,
        instructions: opts.instructions,
        trigger: opts.trigger,
        createdAt: now,
        createdFrom: {
          experienceIds: opts.experienceIds,
          ...(opts.mutationId === undefined ? {} : { mutationId: opts.mutationId }),
        },
        evidence: opts.evidence,
      }
      return {
        ...skill,
        currentVersion: nextVersion,
        versions: [...skill.versions, version],
        status: 'CANDIDATE',
        rollbackToVersion: skill.currentVersion,
        updatedAt: now,
      }
    })
    if (updated === undefined) throw new Error(`dsh-evolve: unknown skill ${id}`)
    return updated
  }

  /** Activate a skill (writes the agent-visible body). */
  async activate(id: string, now = new Date().toISOString()): Promise<Skill> {
    const updated = await this.store.update(id, skill => {
      if (!legalSkillTransition(skill.status, 'ACTIVE')) {
        throw new Error(`dsh-evolve: cannot activate ${id} from ${skill.status}`)
      }
      return { ...skill, status: 'ACTIVE', updatedAt: now }
    })
    if (updated === undefined) throw new Error(`dsh-evolve: unknown skill ${id}`)
    await this.syncActiveBody(updated)
    return updated
  }

  /** Deactivate + roll back to the previous version (traceable rollback). */
  async rollback(id: string, reason: string, now = new Date().toISOString()): Promise<Skill> {
    const updated = await this.store.update(id, skill => {
      if (skill.status !== 'ACTIVE') {
        throw new Error(`dsh-evolve: cannot roll back ${id}: status is ${skill.status}`)
      }
      if (skill.versions.length < 2) {
        throw new Error(`dsh-evolve: cannot roll back ${id}: no previous version`)
      }
      const previous = skill.versions[skill.versions.length - 2]
      if (previous === undefined) throw new Error(`dsh-evolve: cannot roll back ${id}: no previous version`)
      const { rollbackToVersion: _ignored, ...rest } = skill
      void _ignored
      return {
        ...rest,
        status: 'CANDIDATE',
        currentVersion: previous.version,
        updatedAt: now,
        versions: [...skill.versions, {
          ...previous,
          version: skill.versions.length + 1,
          createdAt: now,
          createdFrom: { experienceIds: previous.createdFrom.experienceIds },
        }],
      }
    })
    if (updated === undefined) throw new Error(`dsh-evolve: unknown skill ${id}`)
    await this.syncActiveBody(updated)
    return updated
  }

  /** Record a routing outcome for an active skill. */
  async recordUsage(id: string, outcome: 'success' | 'failure', now = new Date().toISOString()): Promise<Skill | undefined> {
    return this.store.update(id, skill => ({
      ...skill,
      updatedAt: now,
      usage: {
        activations: skill.usage.activations + 1,
        successes: skill.usage.successes + (outcome === 'success' ? 1 : 0),
        failures: skill.usage.failures + (outcome === 'failure' ? 1 : 0),
        lastUsedAt: now,
      },
    }))
  }

  /** Write/remove the agent-visible body under skills/active/. */
  private async syncActiveBody(skill: Skill): Promise<void> {
    const path = join(this.activeDir, `${skill.id}.json`)
    if (isAgentVisible(skill.status)) {
      await mkdir(this.activeDir, { recursive: true })
      const current = skill.versions.find(version => version.version === skill.currentVersion)
      if (current === undefined) return
      await writeFile(path, `${JSON.stringify({
        id: skill.id,
        name: skill.name,
        version: current.version,
        description: current.description,
        instructions: current.instructions,
        trigger: current.trigger,
      }, null, 2)}\n`, 'utf8')
    } else {
      await rm(path, { force: true })
    }
  }

  /** Read an agent-visible skill body (returns undefined for non-active). */
  async readActiveBody(id: string): Promise<{ id: string; version: number; instructions: string[] } | undefined> {
    try {
      const content = await readFile(join(this.activeDir, `${id}.json`), 'utf8')
      return JSON.parse(content) as { id: string; version: number; instructions: string[] }
    } catch {
      return undefined
    }
  }
}
