/**
 * Targets + validation engine tests (v0.2 WP3/WP4): memory, profile, skill
 * lifecycle (create/version/rollback/activate), routing, recipe, policy,
 * applier, replay/shadow/eval/promotion.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CollectorEvent } from '../src/contracts/trajectory.js'
import { MemoryStore } from '../src/targets/memory/store.js'
import { ProfileStore } from '../src/targets/profile/store.js'
import { SkillStore } from '../src/targets/skill/store.js'
import { optimizeFromCorrections } from '../src/targets/skill/optimizer.js'
import { RoutingStore, matchSkill, taskKeywords } from '../src/targets/skill-routing/store.js'
import { RecipeStore } from '../src/targets/recipe/store.js'
import { PolicyStore } from '../src/targets/policy/store.js'
import { applyPromotedMutation } from '../src/targets/applier.js'
import { MutationRegistry } from '../src/mutation/registry.js'
import { planMutations } from '../src/mutation/planner.js'
import { runPromotionFlow } from '../src/validation/promotion.js'
import { replaySkillProposal } from '../src/validation/replay.js'
import { evaluateProposal } from '../src/validation/evaluator.js'
import { finalizeCandidate } from '../src/experience/normalizer.js'
import type { ExperienceRecord } from '../src/experience/contracts.js'
import type { Skill, SkillDraft } from '../src/targets/skill/model.js'
import type { TargetStores } from '../src/targets/applier.js'
import type { MutationProposal } from '../src/mutation/contracts.js'
import type { EvidenceSummary } from '../src/experience/contracts.js'

/* ------------------------------------------------------------------ */

function stepStart(turn: number, step: number): CollectorEvent { return { type: 'step/start', turn, step } }
function stepEnd(turn: number, step: number): CollectorEvent { return { type: 'step/end', turn, step } }
function userMessage(sourceKind: string): CollectorEvent { return { type: 'user/message', sourceKind } }
function toolCall(turn: number, step: number, name: string, args: string): CollectorEvent {
  return { type: 'tool/call', data: { name, arguments: args, turn, step } }
}
function toolResult(turn: number, step: number, opts: { isError?: boolean; text?: string; code?: string } = {}): CollectorEvent {
  const isError = opts.isError ?? false
  return {
    type: 'tool/result',
    data: {
      isError,
      ...(isError ? { error: { name: 'Error', ...(opts.code === undefined ? {} : { code: opts.code }), text: opts.text ?? 'boom' } } : {}),
      contentText: opts.text ?? 'ok',
      turn,
      step,
    },
  }
}
function turnEnd(reasonKind: string): CollectorEvent { return { type: 'turn/end', reasonKind } }

const EVIDENCE: EvidenceSummary = { sessions: 3, occurrences: 4, successfulOccurrences: 3, failedOccurrences: 1, confidence: 0.7 }

function stored(candidate: ReturnType<typeof finalizeCandidate>, id: string): ExperienceRecord {
  return {
    ...candidate,
    id,
    status: 'CANDIDATE',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    sessionIds: ['s1', 's2', 's3'],
    evidence: EVIDENCE,
    provenance: { origin: { local: true }, version: 1 },
  }
}

/* ------------------------------------------------------------------ */

describe('memory + profile targets', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  it('upserts memory facts by identity and activates them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-t1-'))
    dirs.push(dir)
    const memory = new MemoryStore(dir)
    const first = await memory.upsert({ subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' })
    const second = await memory.upsert({ subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' }, { status: 'ACTIVE' })
    expect(second.id).toBe(first.id) // identity-dedup
    const active = await memory.listActive()
    expect(active).toHaveLength(1)
    expect(active[0]?.fact.value).toBe('pnpm')
  })

  it('stores profile preferences as ACTIVE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-t1-'))
    dirs.push(dir)
    const profile = new ProfileStore(dir)
    await profile.upsert({ preference: 'pnpm over npm', over: 'npm', scope: 'workspace' }, { status: 'ACTIVE' })
    const active = await profile.listActive()
    expect(active[0]?.preference.preference).toBe('pnpm over npm')
  })
})

/* ------------------------------------------------------------------ */

describe('skill target', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  const draft: SkillDraft = {
    name: 'install-with-pnpm',
    description: 'Use pnpm instead of npm after repeated failures',
    trigger: { actionKeys: ['a-fail'], tools: ['bash'], keywords: ['install'] },
    instructions: ['Prefer pnpm install over npm install.'],
  }

  async function makeSkill(): Promise<{ store: SkillStore; skill: Skill }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-t4-'))
    dirs.push(dir)
    const store = new SkillStore(dir)
    const skill = await store.createCandidate(draft, { source: 'generated', experienceIds: ['e1'], evidence: EVIDENCE })
    return { store, skill }
  }

  it('creates a CANDIDATE skill and activates it (writes agent-visible body)', async () => {
    const { store, skill } = await makeSkill()
    expect(skill.status).toBe('CANDIDATE')
    await store.activate(skill.id)
    expect((await store.getById(skill.id))?.status).toBe('ACTIVE')
    const body = await store.readActiveBody(skill.id)
    expect(body?.version).toBe(1)
    expect(body?.instructions[0]).toContain('pnpm')
    expect((await store.listActive())).toHaveLength(1)
  })

  it('adds candidate v2 and rolls back to v1 with version history', async () => {
    const { store, skill } = await makeSkill()
    await store.activate(skill.id)
    await store.addCandidateVersion(skill.id, {
      description: 'v2 with corrected trigger',
      instructions: [...draft.instructions, 'Use pnpm install --save-dev.'],
      trigger: { actionKeys: ['a-fail', 'a-ok'] },
      experienceIds: ['e2'],
      evidence: EVIDENCE,
    })
    expect((await store.getById(skill.id))?.currentVersion).toBe(2)
    expect((await store.getById(skill.id))?.status).toBe('CANDIDATE')
    await store.activate(skill.id)
    const rolled = await store.rollback(skill.id, 'v2 regressed')
    expect(rolled.currentVersion).toBe(1)
    expect(rolled.status).toBe('CANDIDATE')
    expect(rolled.versions.length).toBeGreaterThanOrEqual(3) // immutable history
  })

  it('enforces the community download chain and usage recording', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-t4-'))
    dirs.push(dir)
    const store = new SkillStore(dir)
    // community skills start QUARANTINED (never auto-active)
    const community = await store.createCandidate({
      name: 'community-skill', description: 'downloaded', trigger: {}, instructions: ['x'],
    }, { source: 'community', experienceIds: ['c1'], evidence: EVIDENCE })
    expect(community.status).toBe('QUARANTINED')
    await store.transition(community.id, 'STATIC_SCAN')
    await store.transition(community.id, 'SEMANTIC_REVIEW')
    await store.transition(community.id, 'LOCAL_TEST')
    await store.transition(community.id, 'CANDIDATE')
    await store.activate(community.id)
    expect((await store.getById(community.id))?.status).toBe('ACTIVE')
    await expect(store.transition(community.id, 'REJECTED')).rejects.toThrow(/illegal/) // ACTIVE → REJECTED not legal
    await store.recordUsage(community.id, 'success')
    await store.recordUsage(community.id, 'failure')
    const usage = (await store.getById(community.id))?.usage
    expect(usage?.activations).toBe(2)
    expect(usage?.successes).toBe(1)
    expect(usage?.failures).toBe(1)
  })

  it('optimizer drafts v+1 from corrections targeting the skill', async () => {
    const { store, skill } = await makeSkill()
    const result = optimizeFromCorrections(skill, [{
      context: 'c',
      failed: { tool: 'bash', actionKey: 'a-fail', args: '{"command":"npm install"}' },
      succeeded: { tool: 'bash', actionKey: 'a-ok', args: '{"command":"pnpm install"}' },
      failureKeys: ['k1'],
    }])
    expect(result).toBeDefined()
    expect(result?.draft.instructions.some(line => line.includes('pnpm'))).toBe(true)
    expect(result?.draft.trigger.actionKeys).toContain('a-ok')
  })
})

/* ------------------------------------------------------------------ */

describe('skill routing', () => {
  it('scores and ranks skills against task contexts', () => {
    const skill = {
      id: 'sk-1', name: 'install', version: 1, status: 'ACTIVE' as const,
      trigger: { keywords: ['install', 'dependencies'], tools: ['bash'] },
    }
    const match = matchSkill(skill, { text: 'please install the dependencies with pnpm', tools: ['bash'] })
    expect(match.score).toBeGreaterThan(0)
    expect(match.reasons.length).toBeGreaterThan(0)
    const nomatch = matchSkill(skill, { text: 'refactor the ui components' })
    expect(nomatch.score).toBe(0)
  })

  it('records wins/losses and win rates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-t5-'))
    const store = new RoutingStore(dir)
    await store.recordOutcome('sk-1', { text: 'install deps' }, true)
    await store.recordOutcome('sk-1', { text: 'install deps again' }, false)
    const rates = await store.winRates()
    expect(rates['sk-1']?.uses).toBe(2)
    expect(rates['sk-1']?.rate).toBe(0.5)
    await rm(dir, { recursive: true, force: true })
  })

  it('tokenizes task text with stopwords removed', () => {
    expect(taskKeywords('Please help me install the dependencies')).toContain('install')
    expect(taskKeywords('Please help me install the dependencies')).not.toContain('the')
  })
})

/* ------------------------------------------------------------------ */

describe('recipe + policy targets', () => {
  it('creates a workflow recipe from a recipe proposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-t6-'))
    const store = new RecipeStore(dir)
    const proposal: MutationProposal = {
      id: 'mut_recipe1', sourceExperienceIds: ['e1'], target: 'recipe',
      riskLevel: 2, proposedChange: { kind: 'workflow-recipe', phases: ['read', 'bash', 'write', 'bash'] },
      evidence: EVIDENCE, status: 'CANDIDATE', version: 1,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const recipe = await store.fromProposal(proposal)
    expect(recipe.phases).toEqual(['read', 'bash', 'write', 'bash'])
    await store.setStatus(recipe.id, 'ACTIVE')
    expect((await store.listActive())).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })

  it('maps STRATEGY_RESET runtime policy onto the reset-v1 recipe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-t8-'))
    const store = new PolicyStore(dir)
    const proposal: MutationProposal = {
      id: 'mut_runtime1', sourceExperienceIds: ['e1'], target: 'runtime-policy',
      riskLevel: 5, proposedChange: { kind: 'policy-change', pattern: { recommendedAction: 'STRATEGY_RESET' } },
      evidence: EVIDENCE, status: 'CANDIDATE', version: 1,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const record = await store.fromProposal(proposal)
    expect(record.kind).toBe('runtime')
    expect(record.recipeId).toBe('reset-v1')
    await store.setStatus(record.id, 'ACTIVE', true)
    expect(await store.activeRuntimeRecipe()).toBe('reset-v1')
    await rm(dir, { recursive: true, force: true })
  })
})

/* ------------------------------------------------------------------ */

describe('applier + validation + promotion', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  async function makeStores(): Promise<TargetStores> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-prom-'))
    dirs.push(dir)
    return {
      memory: new MemoryStore(dir),
      profile: new ProfileStore(dir),
      skills: new SkillStore(dir),
      recipes: new RecipeStore(dir),
      policies: new PolicyStore(dir),
    }
  }

  const sessions = new Map<string, CollectorEvent[]>([
    ['s1', [
      userMessage('user'),
      stepStart(1, 1), toolCall(1, 1, 'bash', '{"command":"npm install"}'),
      toolResult(1, 1, { isError: true, code: 'E404', text: 'no pkg' }), stepEnd(1, 1),
      userMessage('user'),
      stepStart(2, 1), toolCall(2, 1, 'bash', '{"command":"pnpm install"}'), toolResult(2, 1), stepEnd(2, 1),
      turnEnd('turn_completed'),
    ]],
    ['s2', [
      userMessage('user'),
      stepStart(1, 1), toolCall(1, 1, 'bash', '{"command":"npm install"}'),
      toolResult(1, 1, { isError: true, text: 'nope' }), stepEnd(1, 1),
      userMessage('user'),
      stepStart(2, 1), toolCall(2, 1, 'bash', '{"command":"pnpm install"}'), toolResult(2, 1), stepEnd(2, 1),
      turnEnd('turn_completed'),
    ]],
  ])

  it('applies a promoted memory mutation to the memory store', async () => {
    const stores = await makeStores()
    const proposal: MutationProposal = {
      id: 'mut_mem1', sourceExperienceIds: ['e1'], target: 'memory',
      riskLevel: 0, proposedChange: { kind: 'memory-fact', fact: { subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' } },
      evidence: EVIDENCE, status: 'ACTIVE', version: 2,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const result = await applyPromotedMutation(proposal, stores)
    expect(result.applied).toBe(true)
    const active = await stores.memory.listActive()
    expect(active[0]?.fact.value).toBe('pnpm')
  })

  it('applies a skill-create mutation as a CANDIDATE skill (never auto-active)', async () => {
    const stores = await makeStores()
    const proposal: MutationProposal = {
      id: 'mut_sk1', sourceExperienceIds: ['e1'], target: 'skill-create',
      riskLevel: 3,
      proposedChange: { kind: 'skill-draft', skill: { name: 'use-pnpm', description: 'd', trigger: { actionKeys: ['k'] }, instructions: ['use pnpm'] } },
      evidence: EVIDENCE, status: 'ACTIVE', version: 2,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const result = await applyPromotedMutation(proposal, stores)
    expect(result.applied).toBe(true)
    const candidates = await stores.skills.listByStatus('CANDIDATE')
    expect(candidates).toHaveLength(1)
    expect((await stores.skills.listActive())).toHaveLength(0) // not auto-activated
  })

  it('replays a skill proposal over past sessions', () => {
    const correction = stored(finalizeCandidate({
      kind: 'correction', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: {
        context: 'c',
        failed: { tool: 'bash', actionKey: 'fail-key', args: '{}' },
        succeeded: { tool: 'bash', actionKey: 'ok-key', args: '{}' },
        failureKeys: [],
      },
    }), 'e1')
    const [proposal] = planMutations([correction], { distillSkill: true })
    expect(proposal).toBeDefined()
    const report = replaySkillProposal(proposal!, sessions)
    expect(report.totalMatches).toBeGreaterThan(0)
    expect(report.matchedSessions.length).toBeGreaterThan(0)
  })

  it('evaluates proposals with evidence + replay gates', () => {
    const weak: MutationProposal = {
      id: 'mut_weak', sourceExperienceIds: ['e1'], target: 'runtime-policy',
      riskLevel: 5, proposedChange: { kind: 'policy-change', pattern: { recommendedAction: 'STRATEGY_RESET' } },
      evidence: { sessions: 1, occurrences: 1, successfulOccurrences: 0, failedOccurrences: 1, confidence: 0.1 },
      status: 'CANDIDATE', version: 1,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const outcome = evaluateProposal(weak)
    expect(outcome.passed).toBe(false) // confidence too low
    expect(outcome.method).toBe('eval')
  })

  it('promotion flow: auto-promotes memory, blocks skill-create without user', async () => {
    const stores = await makeStores()
    const regDir = await mkdtemp(join(tmpdir(), 'dsh-evolve-reg-'))
    dirs.push(regDir)
    const registry = new MutationRegistry(regDir)
    const fact = stored(finalizeCandidate({
      kind: 'fact', sessionId: 's1', outcome: 'neutral', compatibility: {},
      payload: { subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' },
    }), 'e1')
    const [memoryProposal] = planMutations([fact])
    await registry.register([memoryProposal!])
    const auto = await runPromotionFlow(registry, stores, memoryProposal!.id, { approver: 'auto', sessions })
    expect(auto.outcome).toBe('promoted')
    expect((await stores.memory.listActive())).toHaveLength(1)

    const correction = stored(finalizeCandidate({
      kind: 'correction', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: {
        context: 'c',
        failed: { tool: 'bash', actionKey: 'fail-key', args: '{}' },
        succeeded: { tool: 'bash', actionKey: 'ok-key', args: '{}' },
        failureKeys: [],
      },
    }), 'e2')
    const [skillProposal] = planMutations([correction], { distillSkill: true })
    await registry.register([skillProposal!])
    await registry.transition(skillProposal!.id, 'CANDIDATE')
    const blocked = await runPromotionFlow(registry, stores, skillProposal!.id, { approver: 'policy', sessions })
    expect(blocked.outcome).toBe('needs-approval')
    const userApproved = await runPromotionFlow(registry, stores, skillProposal!.id, { approver: 'user', sessions })
    expect(userApproved.outcome).toBe('promoted')
    expect((await stores.skills.listByStatus('CANDIDATE')).length).toBe(1)
  })

  it('promotes a runtime-policy mutation (risk 5) to the reset-v1 recipe (Harness Evolution)', async () => {
    const stores = await makeStores()
    const regDir = await mkdtemp(join(tmpdir(), 'dsh-evolve-reg-'))
    dirs.push(regDir)
    const registry = new MutationRegistry(regDir)
    const pattern = stored(finalizeCandidate({
      kind: 'failure-pattern', sessionId: 's1', outcome: 'failure', compatibility: {},
      payload: {
        signature: 'sig', kind: 'repeated-error', repeats: 4,
        description: 'same error repeated 4 times', recommendedAction: 'STRATEGY_RESET',
      },
    }), 'e3')
    const [policyProposal] = planMutations([pattern])
    expect(policyProposal?.target).toBe('runtime-policy')
    await registry.register([policyProposal!])
    const result = await runPromotionFlow(registry, stores, policyProposal!.id, {
      approver: 'policy',
      sessions: new Map([['s1', [
        { type: 'user/message' as const, sourceKind: 'user' },
        { type: 'tool/call' as const, data: { name: 'bash', arguments: '{}', turn: 1, step: 1 } },
        { type: 'tool/result' as const, data: { isError: true, error: { name: 'E', code: 'E1', text: 'x' }, contentText: 'x', turn: 1, step: 1 } },
        { type: 'turn/end' as const, reasonKind: 'error' },
      ]]]),
    })
    expect(result.outcome).toBe('promoted')
    expect(await stores.policies.activeRuntimeRecipe()).toBe('reset-v1')
    const enabled = await stores.policies.listEnabled('runtime')
    expect(enabled).toHaveLength(1)
    expect(enabled[0]?.action).toBe('STRATEGY_RESET')
  })

  it('skill-update chain: correction against an active skill drafts candidate v2', async () => {
    const stores = await makeStores()
    // Create + activate a skill that owns the failing action key.
    const skill = await stores.skills.createCandidate({
      name: 'npm-workflow', description: 'installs via npm',
      trigger: { actionKeys: ['a-fail'], tools: ['bash'], keywords: ['install'] },
      instructions: ['run npm install'],
    }, { source: 'local', experienceIds: ['e0'], evidence: EVIDENCE })
    await stores.skills.activate(skill.id)

    const correction = stored(finalizeCandidate({
      kind: 'correction', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: {
        context: 'c',
        failed: { tool: 'bash', actionKey: 'a-fail', args: '{"command":"npm install"}' },
        succeeded: { tool: 'bash', actionKey: 'a-ok', args: '{"command":"pnpm install"}' },
        failureKeys: ['k1'],
      },
    }), 'e4')
    const active = await stores.skills.listActive()
    const [updateProposal] = planMutations([correction], { distillSkill: true,
      existingSkills: active.map(s => ({
        id: s.id, name: s.name, version: s.currentVersion,
        triggerActionKeys: s.versions[s.versions.length - 1]?.trigger.actionKeys ?? [],
      })),
    })
    expect(updateProposal?.target).toBe('skill-update')
    const regDir = await mkdtemp(join(tmpdir(), 'dsh-evolve-reg-'))
    dirs.push(regDir)
    const registry = new MutationRegistry(regDir)
    await registry.register([updateProposal!])
    const result = await runPromotionFlow(registry, stores, updateProposal!.id, { approver: 'user' })
    expect(result.outcome).toBe('promoted')
    const updated = await stores.skills.getById(skill.id)
    expect(updated?.currentVersion).toBe(2)
    expect(updated?.status).toBe('CANDIDATE') // v2 awaits approval
  })
})
