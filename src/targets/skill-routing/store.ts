/**
 * Skill routing target (v0.2, Target 5 — Skill Routing, risk 1).
 *
 * Learns which skills actually help which tasks. Routing only RECOMMENDS
 * already-ACTIVE skills; it never changes skill content. Matches are pure
 * (keyword overlap + tool/action-key hits) and every activation is recorded so
 * routing evidence accumulates.
 *
 * @module dsh-evolve/targets/skill-routing
 */

import { JsonlStore } from '../../storage/jsonl-store.js'
import type { SkillSummary, SkillTrigger } from '../skill/model.js'

export interface RoutingEntry {
  id: string
  skillId: string
  keywords: string[]
  wins: number
  losses: number
  uses: number
  lastUsedAt?: string
  createdAt: string
}

export interface TaskContext {
  /** Normalized task text (or keywords). */
  text?: string
  /** Tools already observed in the task. */
  tools?: string[]
  /** Canonical action keys observed. */
  actionKeys?: string[]
  /** Task domain, e.g. `coding` (used for compatibility). */
  domain?: string
  /** Primary language, e.g. `typescript` (used for compatibility). */
  language?: string
}

export interface MatchScore {
  skill: SkillSummary
  /** 0..1 overlap score. */
  score: number
  reasons: string[]
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or', 'is', 'are',
  'please', 'help', 'me', 'this', 'that', 'task', 'need', 'want', 'can', 'you',
])

/** Tokenize task text into meaningful keywords. */
export function taskKeywords(text: string | undefined): string[] {
  if (text === undefined) return []
  const tokens = text.toLowerCase().split(/[^a-z0-9._-]+/)
  return [...new Set(tokens.filter(token => token !== '' && !STOPWORDS.has(token)))]
}

/** Score a skill against a task context (pure). */
export function matchSkill(skill: SkillSummary, context: TaskContext): MatchScore {
  const reasons: string[] = []
  let hits = 0
  let total = 0

  const keywords = taskKeywords(context.text)
  const triggerKeywords = skill.trigger.keywords ?? []
  for (const keyword of keywords) {
    total += 1
    if (triggerKeywords.some(entry => keyword.includes(entry) || entry.includes(keyword))) {
      hits += 1
      reasons.push(`keyword:${keyword}`)
    }
  }
  const triggerTools = new Set(skill.trigger.tools ?? [])
  for (const tool of context.tools ?? []) {
    total += 1
    if (triggerTools.has(tool)) {
      hits += 1
      reasons.push(`tool:${tool}`)
    }
  }
  const triggerKeys = new Set(skill.trigger.actionKeys ?? [])
  for (const key of context.actionKeys ?? []) {
    total += 1
    if (triggerKeys.has(key)) {
      hits += 1
      reasons.push('actionKey')
    }
  }
  const score = total === 0 ? 0 : hits / total
  return { skill, score: Math.round(score * 1000) / 1000, reasons }
}

export class RoutingStore {
  private readonly store: JsonlStore<RoutingEntry>

  constructor(root: string) {
    this.store = new JsonlStore(root, 'routing/routing.jsonl')
  }

  async list(): Promise<RoutingEntry[]> {
    return (await this.store.read()).sort((a, b) => b.uses - a.uses)
  }

  /** Rank ACTIVE skills for a task context (score > 0 only). */
  async recommend(skills: readonly SkillSummary[], context: TaskContext): Promise<MatchScore[]> {
    const matches = skills.map(skill => matchSkill(skill, context))
    return matches
      .filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score)
  }

  /** Record one routed activation outcome (updates wins/losses/uses). */
  async recordOutcome(
    skillId: string,
    context: TaskContext,
    success: boolean,
    now = new Date().toISOString(),
  ): Promise<RoutingEntry> {
    const keywords = taskKeywords(context.text)
    const records = await this.store.read()
    const existing = records.find(entry => entry.skillId === skillId)
    if (existing !== undefined) {
      const updated: RoutingEntry = {
        ...existing,
        keywords: [...new Set([...existing.keywords, ...keywords])].slice(0, 24),
        wins: existing.wins + (success ? 1 : 0),
        losses: existing.losses + (success ? 0 : 1),
        uses: existing.uses + 1,
        lastUsedAt: now,
      }
      await this.store.replaceAll(records.map(record => record.id === existing.id ? updated : record))
      return updated
    }
    const created: RoutingEntry = {
      id: `route_${now.replaceAll(/[^0-9a-z]/gi, '').slice(0, 14)}`,
      skillId,
      keywords: keywords.slice(0, 24),
      wins: success ? 1 : 0,
      losses: success ? 0 : 1,
      uses: 1,
      lastUsedAt: now,
      createdAt: now,
    }
    await this.store.append(created)
    return created
  }

  /** Routing win-rate by skill (for reports and routing evidence). */
  async winRates(): Promise<Record<string, { uses: number; wins: number; rate: number }>> {
    const entries = await this.store.read()
    const out: Record<string, { uses: number; wins: number; rate: number }> = {}
    for (const entry of entries) {
      out[entry.skillId] = {
        uses: entry.uses,
        wins: entry.wins,
        rate: entry.uses === 0 ? 0 : Math.round((entry.wins / entry.uses) * 1000) / 1000,
      }
    }
    return out
  }
}
