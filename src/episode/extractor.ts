/**
 * Episode extractor (v0.2, spec §7.1).
 *
 * Splits a session's normalized {@link CollectorEvent} stream into task-level
 * episodes. A new episode begins at a user message that is not a plugin
 * injection; if a session has no such boundary the whole stream is one episode.
 * Pure and deterministic — the same events always produce the same episodes,
 * so runtime and offline replay stay identical.
 *
 * @module dsh-evolve/episode/extractor
 */

import type { CollectorEvent } from '../contracts/trajectory.js'
import type { CorrectionSignal, Episode, EpisodeOutcome } from './contracts.js'

/** Turn/end reasons that mark a task as completed (conservative, case-folded). */
const SUCCESS_REASONS = /(^|[-_ ])(completed?|success|succeeded|done|finished|goal|resolved)([-_ ]|$)/i

/** user/message sources that are NOT a new user task (injections, etc.). */
const NON_TASK_SOURCES = new Set(['plugin', 'system', 'tool'])

/** Deterministic session-agnostic episode id (index + fingerprint of events). */
export function episodeId(sessionId: string, startIndex: number, endIndex: number): string {
  return `${sessionId}:ep:${startIndex}-${endIndex}`
}

function isTaskBoundary(event: CollectorEvent): boolean {
  return event.type === 'user/message' && !NON_TASK_SOURCES.has(event.sourceKind)
}

function isPluginInjection(event: CollectorEvent): boolean {
  return event.type === 'user/message' && event.sourceKind === 'plugin'
}

/** Whether the episode's turn/end reasons signal completion (success). */
function episodeOutcome(events: CollectorEvent[]): EpisodeOutcome {
  const reasons = events
    .filter((event): event is Extract<CollectorEvent, { type: 'turn/end' }> => event.type === 'turn/end')
    .map(event => event.reasonKind)
  if (reasons.some(reason => SUCCESS_REASONS.test(reason))) return 'success'
  // "user followup" = a user message AFTER tool activity began (the task-begin
  // message itself does not count).
  let sawTool = false
  let userAfterTool = false
  for (const event of events) {
    if (event.type === 'tool/call' || event.type === 'tool/result') sawTool = true
    else if (event.type === 'user/message' && event.sourceKind === 'user' && sawTool) userAfterTool = true
  }
  const failed = events.some(event => event.type === 'tool/result' && event.data.isError)
  if (failed && !userAfterTool) return 'failure'
  return 'incomplete'
}

/** Split a session event stream into task-level episodes. */
export function extractEpisodes(sessionId: string, events: readonly CollectorEvent[]): Episode[] {
  const segments: Array<{ start: number; end: number }> = []
  let start = 0
  // A user message after at least one failed tool result is a CORRECTION of the
  // current task (spec §6.3), not a new task boundary.
  let failuresSinceBoundary = 0

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type === 'tool/result' && event.data.isError) failuresSinceBoundary += 1
    if (event.type === 'user/message' && isTaskBoundary(event)) {
      if (i === start) continue // the task-begin message itself
      if (failuresSinceBoundary > 0) continue // correction — stays in this episode
      segments.push({ start, end: i })
      start = i
      failuresSinceBoundary = 0
    }
  }
  segments.push({ start, end: events.length })

  const episodes: Episode[] = []
  for (const segment of segments) {
    if (segment.start >= segment.end) continue
    const slice = events.slice(segment.start, segment.end)
    const episode = buildEpisode(sessionId, segment.start, segment.end, slice)
    if (episode.events.length > 0) episodes.push(episode)
  }
  return episodes
}

function buildEpisode(
  sessionId: string,
  startIndex: number,
  endIndex: number,
  events: CollectorEvent[],
): Episode {
  const turns = new Set<number>()
  let toolCalls = 0
  let failures = 0
  /** Failures accumulated since the last successful tool result. */
  let failuresSinceSuccess = 0
  const corrections: CorrectionSignal[] = []
  let userInterventions = 0
  // user/message events carry no turn; attribute them to the nearest step turn.
  let currentTurn = 0
  let sawTool = false

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event === undefined) continue
    switch (event.type) {
      case 'step/start':
        turns.add(event.turn)
        currentTurn = event.turn
        break
      case 'tool/call':
        turns.add(event.data.turn)
        currentTurn = event.data.turn
        toolCalls += 1
        sawTool = true
        break
      case 'tool/result':
        turns.add(event.data.turn)
        currentTurn = event.data.turn
        sawTool = true
        if (event.data.isError) {
          failures += 1
          failuresSinceSuccess += 1
        } else {
          failuresSinceSuccess = 0 // a success resets the failure baseline
        }
        break
      case 'user/message': {
        if (currentTurn !== 0) turns.add(currentTurn)
        // the task-begin message (before any tool activity) is not a correction
        if (event.sourceKind === 'user' && sawTool) {
          userInterventions += 1
          corrections.push({
            index: i,
            turn: currentTurn,
            afterFailure: failuresSinceSuccess > 0,
            failuresBefore: failuresSinceSuccess,
          })
        }
        break
      }
      case 'turn/end':
        if (currentTurn !== 0) turns.add(currentTurn)
        break
    }
  }

  const outcome = episodeOutcome(events)
  return {
    id: episodeId(sessionId, startIndex, endIndex),
    sessionId,
    startIndex,
    endIndex,
    events,
    turns: [...turns].sort((a, b) => a - b),
    toolCalls,
    failures,
    corrections,
    userInterventions,
    outcome,
  }
}

/** True when a strategy-reset (plugin) injection is present in the events. */
export function hasPluginInjection(events: readonly CollectorEvent[]): boolean {
  return events.some(isPluginInjection)
}
