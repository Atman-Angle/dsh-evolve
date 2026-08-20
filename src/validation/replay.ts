/**
 * Replay validation (v0.2, spec §10 — Replay Validation).
 *
 * Replays a candidate change over stored past sessions WITHOUT changing the
 * agent: how many times would this skill/policy have matched, and would the
 * corrected approach have succeeded? Pure functions over normalized events.
 *
 * @module dsh-evolve/validation/replay
 */

import type { CollectorEvent } from '../contracts/trajectory.js'
import type { MutationProposal } from '../mutation/contracts.js'
import type { SkillTrigger } from '../targets/skill/model.js'
import { extractEpisodes } from '../episode/extractor.js'
import { actionKey } from '../features/invocation-normalizer.js'
import { errorSignatureKey } from '../features/error-normalizer.js'

export interface ReplayMatch {
  sessionId: string
  episodeId: string
  /** How many tool calls in the episode matched the trigger. */
  matches: number
  /** Whether the episode ended successfully. */
  episodeSuccess: boolean
}

export interface ReplayReport {
  proposalId: string
  matchedSessions: string[]
  totalMatches: number
  /** Share of matching episodes that ended successfully. */
  successRate: number
  matches: ReplayMatch[]
}

/** Match a skill trigger against one episode's tool calls. */
export function matchTriggerAgainstEpisode(
  trigger: SkillTrigger,
  episodeEvents: readonly CollectorEvent[],
): number {
  const triggerKeys = new Set(trigger.actionKeys ?? [])
  const triggerTools = new Set(trigger.tools ?? [])
  let matches = 0
  for (const event of episodeEvents) {
    if (event.type === 'tool/call') {
      if (triggerTools.has(event.data.name)) matches += 1
      else if (triggerKeys.has(actionKey(event.data.name, event.data.arguments))) matches += 1
    }
  }
  return matches
}

/** Extract the skill trigger from a skill-create/update proposal. */
export function triggerFromProposal(proposal: MutationProposal): SkillTrigger | undefined {
  const change = proposal.proposedChange as { kind?: string; skill?: { trigger?: SkillTrigger } } | undefined
  if (change?.kind === 'skill-draft' && change.skill?.trigger !== undefined) return change.skill.trigger
  return undefined
}

/**
 * Replay a skill proposal over sessions: hypothetical activations only.
 * @param sessions - map of sessionId → normalized events.
 */
export function replaySkillProposal(
  proposal: MutationProposal,
  sessions: ReadonlyMap<string, readonly CollectorEvent[]>,
): ReplayReport {
  const trigger = triggerFromProposal(proposal)
  const report: ReplayReport = {
    proposalId: proposal.id,
    matchedSessions: [],
    totalMatches: 0,
    successRate: 0,
    matches: [],
  }
  if (trigger === undefined) return report

  for (const [sessionId, events] of sessions) {
    for (const episode of extractEpisodes(sessionId, events)) {
      const matches = matchTriggerAgainstEpisode(trigger, episode.events)
      if (matches > 0) {
        report.totalMatches += matches
        report.matches.push({
          sessionId,
          episodeId: episode.id,
          matches,
          episodeSuccess: episode.outcome === 'success',
        })
        if (!report.matchedSessions.includes(sessionId)) report.matchedSessions.push(sessionId)
      }
    }
  }
  if (report.matches.length > 0) {
    const successes = report.matches.filter(match => match.episodeSuccess).length
    report.successRate = Math.round((successes / report.matches.length) * 1000) / 1000
  }
  return report
}

/** Replay a failure-pattern policy proposal (would-fire counts per session). */
export function replayPolicyProposal(
  proposal: MutationProposal,
  sessions: ReadonlyMap<string, readonly CollectorEvent[]>,
): ReplayReport {
  const change = proposal.proposedChange as { kind?: string; pattern?: { signature?: string } } | undefined
  const signature = change?.pattern?.signature
  const report: ReplayReport = {
    proposalId: proposal.id,
    matchedSessions: [],
    totalMatches: 0,
    successRate: 0,
    matches: [],
  }
  if (signature === undefined) return report
  for (const [sessionId, events] of sessions) {
    for (const episode of extractEpisodes(sessionId, events)) {
      let matches = 0
      for (const event of episode.events) {
        if (event.type === 'tool/result' && event.data.isError) {
          if (event.data.error !== undefined && errorSignatureKey(event.data.error) === signature) matches += 1
        }
      }
      if (matches > 0) {
        report.totalMatches += matches
        report.matches.push({
          sessionId,
          episodeId: episode.id,
          matches,
          episodeSuccess: episode.outcome === 'success',
        })
        if (!report.matchedSessions.includes(sessionId)) report.matchedSessions.push(sessionId)
      }
    }
  }
  return report
}

