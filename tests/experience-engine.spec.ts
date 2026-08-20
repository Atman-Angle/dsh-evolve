/**
 * Experience Engine tests (v0.2 WP1): episode extraction, deterministic
 * mining, deduplication/confidence, and the experience store.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CollectorEvent } from '../src/contracts/trajectory.js'
import { extractEpisodes } from '../src/episode/extractor.js'
import { computeConfidence, buildEvidence } from '../src/experience/confidence.js'
import { mergeCandidates, shouldPromoteToCandidate } from '../src/experience/deduplicator.js'
import { mineEpisode } from '../src/experience/miner.js'
import { finalizeCandidate } from '../src/experience/normalizer.js'
import { ExperienceStore } from '../src/experience/store.js'
import type { ExperienceRecord } from '../src/experience/contracts.js'

/* ------------------------------------------------------------------ */
/* CollectorEvent builders                                             */
/* ------------------------------------------------------------------ */

function stepStart(turn: number, step: number): CollectorEvent {
  return { type: 'step/start', turn, step }
}
function stepEnd(turn: number, step: number): CollectorEvent {
  return { type: 'step/end', turn, step }
}
function userMessage(sourceKind: string): CollectorEvent {
  return { type: 'user/message', sourceKind }
}
function toolCall(turn: number, step: number, name: string, args: string): CollectorEvent {
  return { type: 'tool/call', data: { name, arguments: args, turn, step } }
}
function toolResult(
  turn: number,
  step: number,
  opts: { isError?: boolean; text?: string; code?: string; name?: string } = {},
): CollectorEvent {
  const isError = opts.isError ?? false
  return {
    type: 'tool/result',
    data: {
      isError,
      ...(isError
        ? { error: { name: opts.name ?? 'Error', ...(opts.code === undefined ? {} : { code: opts.code }), text: opts.text ?? 'boom' } }
        : {}),
      contentText: opts.text ?? 'ok',
      turn,
      step,
    },
  }
}
function turnEnd(reasonKind: string): CollectorEvent {
  return { type: 'turn/end', reasonKind }
}

/* ------------------------------------------------------------------ */
/* Episode extractor                                                   */
/* ------------------------------------------------------------------ */

describe('episode extractor', () => {
  it('produces one episode when no task boundary exists', () => {
    const events = [stepStart(1, 1), toolCall(1, 1, 'bash', '{"command":"pwd"}'), toolResult(1, 1), stepEnd(1, 1)]
    const episodes = extractEpisodes('s1', events)
    expect(episodes).toHaveLength(1)
    expect(episodes[0]?.toolCalls).toBe(1)
    expect(episodes[0]?.outcome).toBe('incomplete')
  })

  it('splits at user messages but not at plugin injections', () => {
    const events = [
      userMessage('user'), // task A
      stepStart(1, 1), toolCall(1, 1, 'read', '{"path":"a.ts"}'), toolResult(1, 1), stepEnd(1, 1),
      userMessage('plugin'), // injection — NOT a boundary
      stepStart(2, 1), toolCall(2, 1, 'read', '{"path":"b.ts"}'), toolResult(1, 1), stepEnd(2, 1),
      userMessage('user'), // task B
      stepStart(3, 1), toolCall(3, 1, 'write', '{"content":"x"}'), toolResult(1, 1), stepEnd(3, 1),
    ]
    const episodes = extractEpisodes('s1', events)
    expect(episodes).toHaveLength(2)
    expect(episodes[0]?.toolCalls).toBe(2) // injection does not split task A
    expect(episodes[1]?.toolCalls).toBe(1)
  })

  it('flags user corrections after failures', () => {
    const events = [
      userMessage('user'),
      stepStart(1, 1),
      toolCall(1, 1, 'bash', '{"command":"npm install"}'),
      toolResult(1, 1, { isError: true, code: 'E404', text: 'no such package' }),
      stepEnd(1, 1),
      userMessage('user'), // correction after failure
      stepStart(2, 1),
      toolCall(2, 1, 'bash', '{"command":"pnpm install"}'),
      toolResult(2, 1),
      stepEnd(2, 1),
    ]
    const [episode] = extractEpisodes('s1', events)
    expect(episode?.corrections).toHaveLength(1)
    expect(episode?.corrections[0]?.afterFailure).toBe(true)
    expect(episode?.corrections[0]?.failuresBefore).toBe(1)
  })

  it('computes success / failure / incomplete outcomes', () => {
    const ok = extractEpisodes('s1', [
      userMessage('user'),
      stepStart(1, 1), toolCall(1, 1, 'write', '{}'), toolResult(1, 1), stepEnd(1, 1),
      turnEnd('turn_completed'),
    ])
    expect(ok[0]?.outcome).toBe('success')

    const bad = extractEpisodes('s1', [
      userMessage('user'),
      stepStart(1, 1), toolCall(1, 1, 'bash', '{}'), toolResult(1, 1, { isError: true }), stepEnd(1, 1),
    ])
    expect(bad[0]?.outcome).toBe('failure')

    const partial = extractEpisodes('s1', [
      userMessage('user'),
      stepStart(1, 1), toolCall(1, 1, 'read', '{}'), toolResult(1, 1), stepEnd(1, 1),
    ])
    expect(partial[0]?.outcome).toBe('incomplete')
  })
})

/* ------------------------------------------------------------------ */
/* Deterministic miner                                                 */
/* ------------------------------------------------------------------ */

describe('deterministic miner', () => {
  it('mines a correction candidate from failure → user correction → success', () => {
    const events = [
      userMessage('user'),
      stepStart(1, 1),
      toolCall(1, 1, 'bash', '{"command":"npm install"}'),
      toolResult(1, 1, { isError: true, code: 'E404', text: 'no such package' }),
      stepEnd(1, 1),
      userMessage('user'),
      stepStart(2, 1),
      toolCall(2, 1, 'bash', '{"command":"pnpm install"}'),
      toolResult(2, 1),
      stepEnd(2, 1),
    ]
    const [episode] = extractEpisodes('s1', events)
    const candidates = mineEpisode(episode!, 's1')
    const corrections = candidates.filter(c => c.kind === 'correction')
    expect(corrections).toHaveLength(1)
    const payload = corrections[0]!.payload as { failed: { tool: string }; succeeded: { tool: string } }
    expect(payload.failed.tool).toBe('bash')
    expect(payload.succeeded.tool).toBe('bash')
    expect(corrections[0]?.outcome).toBe('success')
  })

  it('mines a pnpm-over-npm preference from the same correction', () => {
    const events = [
      userMessage('user'),
      stepStart(1, 1),
      toolCall(1, 1, 'bash', '{"command":"npm install"}'),
      toolResult(1, 1, { isError: true, text: 'err' }),
      stepEnd(1, 1),
      userMessage('user'),
      stepStart(2, 1),
      toolCall(2, 1, 'bash', '{"command":"pnpm install"}'),
      toolResult(2, 1),
      stepEnd(2, 1),
    ]
    const [episode] = extractEpisodes('s1', events)
    const candidates = mineEpisode(episode!, 's1')
    const prefs = candidates.filter(c => c.kind === 'preference')
    expect(prefs.some(p => p.summary.includes('pnpm over npm'))).toBe(true)
  })

  it('mines package-manager and test-command facts from successful bash calls', () => {
    const events = [
      userMessage('user'),
      stepStart(1, 1),
      toolCall(1, 1, 'bash', '{"command":"pnpm install"}'),
      toolResult(1, 1),
      stepEnd(1, 1),
      stepStart(2, 1),
      toolCall(2, 1, 'bash', '{"command":"pnpm test"}'),
      toolResult(2, 1),
      stepEnd(2, 1),
    ]
    const [episode] = extractEpisodes('s1', events)
    const candidates = mineEpisode(episode!, 's1')
    const facts = candidates.filter(c => c.kind === 'fact')
    const pm = facts.find(f => (f.payload as { subject: string }).subject === 'package-manager')
    expect(pm).toBeDefined()
    expect((pm!.payload as { value: string }).value).toBe('pnpm')
    const test = facts.find(f => (f.payload as { subject: string }).subject === 'test-command')
    expect(test).toBeDefined()
  })

  it('mines a successful-procedure candidate from a successful episode', () => {
    const events = [
      userMessage('user'),
      stepStart(1, 1),
      toolCall(1, 1, 'bash', '{"command":"pnpm install"}'),
      toolResult(1, 1),
      stepEnd(1, 1),
      stepStart(2, 1),
      toolCall(2, 1, 'read', '{"path":"src/a.ts"}'),
      toolResult(2, 1, { text: 'export const a = 1' }),
      stepEnd(2, 1),
      stepStart(3, 1),
      toolCall(3, 1, 'write', '{"path":"src/a.ts","content":"export const a = 2"}'),
      toolResult(3, 1),
      stepEnd(3, 1),
      turnEnd('turn_completed'),
    ]
    const [episode] = extractEpisodes('s1', events)
    const candidates = mineEpisode(episode!, 's1')
    const procedures = candidates.filter(c => c.kind === 'successful-procedure')
    expect(procedures).toHaveLength(1)
    const steps = (procedures[0]!.payload as { steps: unknown[] }).steps
    expect(steps).toHaveLength(3)
  })

  it('mines a repeated-error failure pattern', () => {
    const events = [
      userMessage('user'),
      stepStart(1, 1),
      toolCall(1, 1, 'bash', '{"command":"node x.js"}'),
      toolResult(1, 1, { isError: true, code: 'MODULE_NOT_FOUND', text: 'Cannot find module x' }),
      stepEnd(1, 1),
      stepStart(2, 1),
      toolCall(2, 1, 'bash', '{"command":"node x.js"}'),
      toolResult(2, 1, { isError: true, code: 'MODULE_NOT_FOUND', text: 'Cannot find module x' }),
      stepEnd(2, 1),
      stepStart(3, 1),
      toolCall(3, 1, 'bash', '{"command":"node x.js"}'),
      toolResult(3, 1, { isError: true, code: 'MODULE_NOT_FOUND', text: 'Cannot find module x' }),
      stepEnd(3, 1),
    ]
    const [episode] = extractEpisodes('s1', events)
    const candidates = mineEpisode(episode!, 's1')
    const patterns = candidates.filter(c => c.kind === 'failure-pattern')
    expect(patterns.some(p => (p.payload as { kind: string }).kind === 'repeated-error')).toBe(true)
    expect(patterns[0]?.outcome).toBe('failure')
  })
})

/* ------------------------------------------------------------------ */
/* Deduplicator + confidence                                           */
/* ------------------------------------------------------------------ */

describe('deduplicator + confidence', () => {
  const baseCandidate = finalizeCandidate({
    kind: 'correction',
    sessionId: 's1',
    outcome: 'success',
    compatibility: {},
    payload: {
      context: 'c',
      failed: { tool: 'bash', actionKey: 'a1', args: '{"command":"npm install"}' },
      succeeded: { tool: 'bash', actionKey: 'a2', args: '{"command":"pnpm install"}' },
      failureKeys: ['k1'],
    },
  })

  it('merges identical summaryKeys across sessions and grows evidence', () => {
    const c2 = { ...baseCandidate, sessionId: 's2' }
    const outcome = mergeCandidates([], [baseCandidate, c2], '2025-01-01T00:00:00.000Z')
    expect(outcome.records).toHaveLength(1)
    expect(outcome.created).toHaveLength(1)
    const record = outcome.records[0]!
    expect(record.evidence.sessions).toBe(2)
    expect(record.evidence.occurrences).toBe(2)
    expect(record.evidence.successfulOccurrences).toBe(2)
    expect(record.sessionIds).toEqual(['s1', 's2'])
  })

  it('promotes DISCOVERED → CANDIDATE once evidence thresholds are met', () => {
    let records: ExperienceRecord[] = []
    for (const session of ['s1', 's2', 's3']) {
      const outcome = mergeCandidates(records, [{ ...baseCandidate, sessionId: session }], `2025-01-01T00:00:0${session.slice(1)}.000Z`)
      records = outcome.records
    }
    expect(records[0]?.status).toBe('CANDIDATE')
    expect(shouldPromoteToCandidate(records[0]!)).toBe(true)
  })

  it('computes conservative confidence that grows with support', () => {
    const low = buildEvidence({ sessions: 1, occurrences: 1, successfulOccurrences: 1, failedOccurrences: 0 })
    const high = buildEvidence({ sessions: 4, occurrences: 6, successfulOccurrences: 5, failedOccurrences: 1 })
    expect(low.confidence).toBeLessThan(high.confidence)
    expect(low.confidence).toBeGreaterThan(0)
    expect(high.confidence).toBeLessThanOrEqual(1)
    expect(computeConfidence({ sessions: 0, occurrences: 0, successfulOccurrences: 0, failedOccurrences: 0 })).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* Experience store                                                    */
/* ------------------------------------------------------------------ */

describe('experience store', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function makeStore(): Promise<ExperienceStore> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-exp-'))
    dirs.push(dir)
    return new ExperienceStore(dir)
  }

  it('persists merged candidates and reads them back', async () => {
    const store = await makeStore()
    const candidates = [finalizeCandidate({
      kind: 'fact',
      sessionId: 's1',
      outcome: 'neutral',
      compatibility: {},
      payload: { subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' },
    })]
    const { created } = await store.merge(candidates)
    expect(created).toHaveLength(1)
    const records = await store.list()
    expect(records).toHaveLength(1)
    const byId = await store.getById(records[0]!.id)
    expect(byId?.payload).toMatchObject({ value: 'pnpm' })
    expect(byId?.provenance.origin.local).toBe(true)
  })

  it('aggregates counts by kind and status', async () => {
    const store = await makeStore()
    await store.merge([finalizeCandidate({
      kind: 'failure-pattern',
      sessionId: 's1',
      outcome: 'failure',
      compatibility: {},
      payload: {
        signature: 'sig', kind: 'repeated-error', repeats: 3,
        description: 'same error repeated 3 times', recommendedAction: 'STRATEGY_RESET',
      },
    })])
    const aggregate = await store.aggregate()
    expect(aggregate.total).toBe(1)
    expect(aggregate.kind['failure-pattern']).toBe(1)
    expect(aggregate.status['DISCOVERED']).toBe(1)
  })
})
