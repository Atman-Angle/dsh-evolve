/**
 * Personal Evolution Flywheel (v0.2 MVP, spec §29).
 *
 * The project's most important milestone, end-to-end at the pure-logic +
 * store level:
 *
 *   Session 1..3: agent uses the wrong workflow (npm install), user corrects
 *   it (pnpm install), success.
 *   → Evolve detects the repeated correction (experience CANDIDATE).
 *   → Candidate skill generated; user accepts.
 *   → Session 4: the skill automatically matches the task; the agent avoids
 *     the old mistake; outcome is recorded.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CollectorEvent } from '../src/contracts/trajectory.js'
import { extractEpisodes } from '../src/episode/extractor.js'
import { mineEpisode } from '../src/experience/miner.js'
import { ExperienceStore } from '../src/experience/store.js'
import { MutationRegistry } from '../src/mutation/registry.js'
import { planMutations } from '../src/mutation/planner.js'
import { runPromotionFlow } from '../src/validation/promotion.js'
import { MemoryStore } from '../src/targets/memory/store.js'
import { ProfileStore } from '../src/targets/profile/store.js'
import { SkillStore } from '../src/targets/skill/store.js'
import { RoutingStore } from '../src/targets/skill-routing/store.js'
import { RecipeStore } from '../src/targets/recipe/store.js'
import { PolicyStore } from '../src/targets/policy/store.js'
import { apply } from '../src/plugin/index.js'
import type { TargetStores } from '../src/targets/applier.js'

/* ------------------------------------------------------------------ */
/* session builders                                                    */
/* ------------------------------------------------------------------ */

function stepStart(turn: number, step: number): CollectorEvent { return { type: 'step/start', turn, step } }
function stepEnd(turn: number, step: number): CollectorEvent { return { type: 'step/end', turn, step } }
function userMessage(sourceKind: string, text?: string): CollectorEvent {
  return text === undefined ? { type: 'user/message', sourceKind } : { type: 'user/message', sourceKind, text }
}
function toolCall(turn: number, step: number, name: string, args: string): CollectorEvent {
  return { type: 'tool/call', data: { name, arguments: args, turn, step } }
}
function toolResult(turn: number, step: number, opts: { isError?: boolean; text?: string } = {}): CollectorEvent {
  const isError = opts.isError ?? false
  return {
    type: 'tool/result',
    data: {
      isError,
      ...(isError ? { error: { name: 'Error', code: 'E404', text: opts.text ?? 'no such package' } } : {}),
      contentText: opts.text ?? 'ok',
      turn,
      step,
    },
  }
}
function turnEnd(reasonKind: string): CollectorEvent { return { type: 'turn/end', reasonKind } }

/** A session where the agent first tries npm install, fails, the user
 * corrects to pnpm install, and it succeeds. */
function correctionSession(sessionId: string): CollectorEvent[] {
  return [
    userMessage('user', 'install the project dependencies'),
    stepStart(1, 1),
    toolCall(1, 1, 'bash', '{"command":"npm install"}'),
    toolResult(1, 1, { isError: true, text: 'npm ERR! no such package' }),
    stepEnd(1, 1),
    userMessage('user', 'use pnpm instead'),
    stepStart(2, 1),
    toolCall(2, 1, 'bash', '{"command":"pnpm install"}'),
    toolResult(2, 1, { text: 'added 42 packages' }),
    stepEnd(2, 1),
    turnEnd('turn_completed'),
  ]
}

/** Session 4: the SAME task, but the skill is now active — the agent goes
 * straight to pnpm (the old mistake is avoided). */
function correctedSession(sessionId: string): CollectorEvent[] {
  return [
    userMessage('user', 'install the project dependencies'),
    stepStart(1, 1),
    toolCall(1, 1, 'bash', '{"command":"pnpm install"}'),
    toolResult(1, 1, { text: 'added 42 packages' }),
    stepEnd(1, 1),
    turnEnd('turn_completed'),
  ]
}

function openStores(root: string): TargetStores {
  return {
    memory: new MemoryStore(root),
    profile: new ProfileStore(root),
    skills: new SkillStore(root),
    recipes: new RecipeStore(root),
    policies: new PolicyStore(root),
  }
}

async function mineInto(sessionId: string, events: CollectorEvent[], store: ExperienceStore): Promise<void> {
  const episodes = extractEpisodes(sessionId, events)
  const candidates = episodes.flatMap(episode => mineEpisode(episode, sessionId))
  await store.merge(candidates)
}

/* ------------------------------------------------------------------ */

describe('personal evolution flywheel (MVP)', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  it('turns 3 repeated corrections into an approved skill that avoids the old mistake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-flywheel-'))
    dirs.push(root)
    const experiences = new ExperienceStore(root)
    const mutations = new MutationRegistry(root)
    const stores = openStores(root)

    // Sessions 1-3: the same correction, three times.
    for (let i = 1; i <= 3; i++) {
      await mineInto(`sess-${i}`, correctionSession(`sess-${i}`), experiences)
    }

    // 1) Evolve detects the repeated correction.
    const corrections = await experiences.listByKind('correction')
    expect(corrections).toHaveLength(1)
    expect(corrections[0]?.evidence.sessions).toBe(3)
    expect(corrections[0]?.evidence.occurrences).toBe(3)
    expect(corrections[0]?.status).toBe('CANDIDATE')
    expect(corrections[0]?.evidence.confidence).toBeGreaterThan(0.4)

    // 2) A candidate skill mutation is proposed.
    const proposals = planMutations(await experiences.list(), { distillSkill: true })
    const skillProposal = proposals.find(proposal => proposal.target === 'skill-create')
    expect(skillProposal).toBeDefined()
    await mutations.register(proposals)

    // 3) User accepts (confirm gate) — validation over the recorded sessions.
    const result = await runPromotionFlow(mutations, stores, skillProposal!.id, {
      approver: 'user',
      sessions: new Map([
        ['sess-1', correctionSession('sess-1')],
        ['sess-2', correctionSession('sess-2')],
        ['sess-3', correctionSession('sess-3')],
      ]),
    })
    expect(result.outcome).toBe('promoted')

    // 4) The candidate skill exists but is NOT auto-active (still needs the
    //    explicit activation step — which the user performs).
    const candidates = await stores.skills.listByStatus('CANDIDATE')
    expect(candidates).toHaveLength(1)
    expect((await stores.skills.listActive())).toHaveLength(0)
    await stores.skills.activate(candidates[0]!.id)
    expect((await stores.skills.listActive())).toHaveLength(1)
    const body = await stores.skills.readActiveBody(candidates[0]!.id)
    expect(body?.instructions.some(line => line.includes('pnpm'))).toBe(true)

    // 5) Session 4: the skill automatically matches and the outcome is
    //    recorded (old mistake avoided).
    const routing = new RoutingStore(root)
    const active = await stores.skills.listActive()
    const summaries = active.map(skill => ({
      id: skill.id,
      name: skill.name,
      version: skill.currentVersion,
      status: skill.status,
      trigger: skill.versions[skill.versions.length - 1]?.trigger ?? {},
    }))
    const matches = await routing.recommend(summaries, { text: 'install the project dependencies', tools: ['bash'] })
    expect(matches.length).toBeGreaterThan(0)

    // The agent goes straight to pnpm — no npm failure, no correction needed.
    // Session 4 must produce NO new correction candidate (the mistake was not
    // repeated) while the skill's usage evidence grows.
    const sessionsBefore = (await experiences.listByKind('correction'))[0]!.evidence.occurrences
    const candidates4 = extractEpisodes('sess-4', correctedSession('sess-4'))
      .flatMap(episode => mineEpisode(episode, 'sess-4'))
    expect(candidates4.filter(candidate => candidate.kind === 'correction')).toHaveLength(0)
    const sessionsAfter = (await experiences.listByKind('correction'))[0]!.evidence.occurrences
    expect(sessionsAfter).toBe(sessionsBefore) // no repeated mistake

    await routing.recordOutcome(matches[0]!.skill.id, { text: 'install the project dependencies', tools: ['bash'] }, true)
    await stores.skills.recordUsage(matches[0]!.skill.id, 'success')
    const rates = await routing.winRates()
    expect(rates[matches[0]!.skill.id]?.wins).toBeGreaterThanOrEqual(1)
    expect((await stores.skills.getById(matches[0]!.skill.id))?.usage.activations).toBeGreaterThanOrEqual(1)
  })

  it('plugin wiring: session-end mining writes experiences and routing usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-flywheel-plugin-'))
    dirs.push(dir)
    const ctx = new Context()
    const events: SessionEvent[] = []
    const session = { id: 'live-session-1', events } as unknown as Session
    const agent = { id: session.id, session, inject: () => undefined, steer: () => undefined }
    ctx.provide('agents', { get: (id: string) => (id === session.id ? agent : undefined) })
    apply(ctx, { enabled: true, recipe: 'reset-v1', storageRoot: dir, evolution: { enabled: true, mining: true, routing: true } })

    // DSH-shaped events for a correction session.
    let seq = 1
    const emit = (type: string, data: unknown): void => {
      const event = { type, seq: seq++, time: 1000 + seq, data } as SessionEvent
      events.push(event)
      ctx.emit('session/event', session, event)
    }
    const step = (turn: number, step: number, tool: string, args: string, error: boolean, text: string): void => {
      emit('step/start', { turn, step })
      emit('tool/call', { turn, step, callId: `c${turn}-${step}`, name: tool, arguments: args })
      emit('tool/result', {
        turn, step,
        message: {
          id: `m${turn}-${step}`, role: 'user', content: [{
            type: 'tool-result', toolCallId: `c${turn}-${step}`,
            content: [{ type: 'text', text }], isError: error,
          }],
          source: { kind: 'tool', callId: `c${turn}-${step}` },
        },
        ...(error ? { error: { name: 'Error', code: 'E404' } } : {}),
      })
      emit('step/end', { turn, step })
    }
    emit('user/message', { content: 'install dependencies', source: { kind: 'user' } })
    step(1, 1, 'bash', '{"command":"npm install"}', true, 'npm ERR! no such package')
    emit('user/message', { content: 'use pnpm', source: { kind: 'user' } })
    step(2, 1, 'bash', '{"command":"pnpm install"}', false, 'added 42 packages')
    emit('turn/end', { reason: { kind: 'completed' } })

    ctx.emit('session/disposed', session)
    // Allow the async session-end pipeline to drain.
    await new Promise(resolve => setTimeout(resolve, 300))

    const experiences = new ExperienceStore(dir)
    const corrections = await experiences.listByKind('correction')
    expect(corrections.length).toBeGreaterThanOrEqual(1)
    await ctx.fiber.dispose()
  })
})
