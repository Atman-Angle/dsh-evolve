/**
 * Shadow validation (v0.2, spec §10 — Shadow Mode).
 *
 * Community experiences and candidate policies run in shadow: they match
 * tasks, compute "what would happen if enabled", never change the agent, and
 * record outcomes. Only after enough local evidence does promotion happen.
 *
 * @module dsh-evolve/validation/shadow
 */

import type { CollectorEvent } from '../contracts/trajectory.js'
import type { MutationProposal } from '../mutation/contracts.js'
import type { TaskContext } from '../targets/skill-routing/store.js'
import { matchSkill, taskKeywords } from '../targets/skill-routing/store.js'
import type { SkillSummary } from '../targets/skill/model.js'
import { replaySkillProposal } from './replay.js'

export interface ShadowRecord {
  /** The matched task context (normalized). */
  context: TaskContext
  /** What the shadow run would have done. */
  wouldDo: string
  /** Whether the real (non-shadow) run succeeded. */
  realOutcome: 'success' | 'failure' | 'unknown'
  /** Whether the shadow prediction agreed with reality. */
  agreed: boolean | undefined
  at: string
}

export interface ShadowReport {
  proposalId: string
  shadowedRuns: number
  agreements: number
  /** Agreement rate over runs with known outcomes. */
  agreementRate: number
  records: ShadowRecord[]
}

/** The shadow interpreter for a proposal's action. */
export function shadowAction(proposal: MutationProposal, context: TaskContext): string {
  const change = proposal.proposedChange as { kind?: string; skill?: { name?: string } } | undefined
  switch (proposal.target) {
    case 'skill-create':
    case 'skill-update':
      return change?.kind === 'skill-draft'
        ? `would apply skill "${change.skill?.name ?? '?'}" to this task`
        : 'would update matching skill'
    case 'runtime-policy':
    case 'context-policy':
    case 'tool-policy':
      return 'would fire the policy change (strategy reset / tool surface / compaction)'
    default:
      return 'would apply the mutation'
  }
}

/**
 * Run one shadow pass over a task context: record what WOULD happen, without
 * changing the agent. Real outcomes are recorded later by the runtime.
 */
export function shadowRun(
  proposal: MutationProposal,
  context: TaskContext,
  opts: { realOutcome?: 'success' | 'failure' | 'unknown'; at?: string } = {},
): ShadowRecord {
  return {
    context,
    wouldDo: shadowAction(proposal, context),
    realOutcome: opts.realOutcome ?? 'unknown',
    agreed: undefined, // filled once the real outcome is known
    at: opts.at ?? new Date().toISOString(),
  }
}

/**
 * Shadow-match a skill proposal over past sessions and a set of task contexts:
 * returns how many contexts would have activated the skill (replay-backed).
 */
export function shadowSkillProposal(
  proposal: MutationProposal,
  sessions: ReadonlyMap<string, readonly CollectorEvent[]>,
  contexts: readonly TaskContext[],
): ShadowReport {
  const replay = replaySkillProposal(proposal, sessions)
  const summary: SkillSummary = {
    id: proposal.id,
    name: 'shadow-skill',
    version: 1,
    status: 'CANDIDATE',
    trigger: { keywords: contexts.flatMap(context => taskKeywords(context.text)) },
  }
  const records: ShadowRecord[] = []
  for (const context of contexts) {
    const matched = matchSkill(summary, context)
    records.push({
      context,
      wouldDo: matched.score > 0 ? `would activate shadow skill (score ${matched.score})` : 'no match',
      realOutcome: 'unknown',
      agreed: undefined,
      at: new Date().toISOString(),
    })
  }
  return {
    proposalId: proposal.id,
    shadowedRuns: records.length,
    agreements: replay.matches.length,
    agreementRate: replay.matches.length === 0 ? 0 : Math.min(1, replay.successRate),
    records,
  }
}

/** Record the real outcome of a shadowed run (updates agreement stats). */
export function recordShadowOutcome(
  report: ShadowReport,
  index: number,
  realOutcome: 'success' | 'failure' | 'unknown',
): ShadowReport {
  const records = report.records.map((record, i) => {
    if (i !== index) return record
    const agreed = realOutcome === 'unknown'
      ? undefined
      : (record.wouldDo !== 'no match') === (realOutcome === 'success')
    return { ...record, realOutcome, agreed }
  })
  const known = records.filter(record => record.agreed !== undefined)
  const agreements = known.filter(record => record.agreed).length
  return {
    ...report,
    records,
    agreements,
    agreementRate: known.length === 0 ? 0 : Math.round((agreements / known.length) * 1000) / 1000,
  }
}
