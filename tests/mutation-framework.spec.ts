/**
 * Mutation framework tests (v0.2 WP2): planner mapping, risk gates, registry
 * lifecycle with transitions, promotion, rollback.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalizeCandidate } from '../src/experience/normalizer.js'
import type { ExperienceRecord } from '../src/experience/contracts.js'
import { planMutations } from '../src/mutation/planner.js'
import { MutationRegistry, legalTransition } from '../src/mutation/registry.js'
import { canAutoActivate, gateForTarget, requiredGate, TARGET_RISK } from '../src/mutation/risk.js'
import type { MutationProposal } from '../src/mutation/contracts.js'

function stored(candidate: ReturnType<typeof finalizeCandidate>, id: string): ExperienceRecord {
  return {
    ...candidate,
    id,
    status: 'CANDIDATE',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    sessionIds: ['s1', 's2', 's3'],
    evidence: { sessions: 3, occurrences: 4, successfulOccurrences: 3, failedOccurrences: 1, confidence: 0.7 },
    provenance: { origin: { local: true }, version: 1 },
  }
}

describe('risk model', () => {
  it('assigns spec §9 risk levels per target', () => {
    expect(TARGET_RISK.memory).toBe(0)
    expect(TARGET_RISK.profile).toBe(1)
    expect(TARGET_RISK['skill-routing']).toBe(1)
    expect(TARGET_RISK.recipe).toBe(2)
    expect(TARGET_RISK['skill-create']).toBe(3)
    expect(TARGET_RISK['skill-update']).toBe(3)
    expect(TARGET_RISK['context-policy']).toBe(4)
    expect(TARGET_RISK['tool-policy']).toBe(4)
    expect(TARGET_RISK['runtime-policy']).toBe(5)
  })

  it('maps gates: auto → human-review', () => {
    expect(requiredGate(0)).toBe('auto')
    expect(requiredGate(1)).toBe('auto-visible')
    expect(requiredGate(2)).toBe('shadow')
    expect(requiredGate(3)).toBe('confirm')
    expect(requiredGate(4)).toBe('eval')
    expect(requiredGate(5)).toBe('eval-shadow-rollback')
    expect(requiredGate(6)).toBe('human-review')
    expect(gateForTarget('runtime-policy')).toBe('eval-shadow-rollback')
  })

  it('confirm gate never auto-activates; eval gates need validation', () => {
    expect(canAutoActivate('auto', false)).toBe(true)
    expect(canAutoActivate('auto-visible', false)).toBe(true)
    expect(canAutoActivate('shadow', true)).toBe(true)
    expect(canAutoActivate('shadow', false)).toBe(false)
    expect(canAutoActivate('eval', true)).toBe(true)
    expect(canAutoActivate('confirm', true)).toBe(false)
  })
})

describe('mutation planner', () => {
  it('maps fact → memory, preference → profile', () => {
    const fact = stored(finalizeCandidate({
      kind: 'fact', sessionId: 's1', outcome: 'neutral', compatibility: {},
      payload: { subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' },
    }), 'exp-fact')
    const pref = stored(finalizeCandidate({
      kind: 'preference', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: { preference: 'pnpm over npm', over: 'npm', scope: 'workspace' },
    }), 'exp-pref')
    const proposals = planMutations([fact, pref])
    expect(proposals.map(p => p.target).sort()).toEqual(['memory', 'profile'])
    expect(proposals.find(p => p.target === 'memory')?.riskLevel).toBe(0)
    expect(proposals.find(p => p.target === 'profile')?.riskLevel).toBe(1)
  })

  it('maps correction → skill-create with a draft (the MVP chain)', () => {
    const correction = stored(finalizeCandidate({
      kind: 'correction', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: {
        context: 'c',
        failed: { tool: 'bash', actionKey: 'a-fail', args: '{"command":"npm install"}' },
        succeeded: { tool: 'bash', actionKey: 'a-ok', args: '{"command":"pnpm install"}' },
        failureKeys: ['k1'],
      },
    }), 'exp-corr')
    const [proposal] = planMutations([correction], { distillSkill: true })
    expect(proposal?.target).toBe('skill-create')
    expect(proposal?.riskLevel).toBe(3)
    const draft = proposal?.proposedChange as { kind: string; skill: { instructions: string[] } }
    expect(draft.kind).toBe('skill-draft')
    expect(draft.skill.instructions.length).toBeGreaterThan(0)
  })

  it('maps correction → skill-update when an active skill claims the failed step', () => {
    const correction = stored(finalizeCandidate({
      kind: 'correction', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: {
        context: 'c',
        failed: { tool: 'bash', actionKey: 'a-fail', args: '{}' },
        succeeded: { tool: 'bash', actionKey: 'a-ok', args: '{}' },
        failureKeys: [],
      },
    }), 'exp-corr')
    const [proposal] = planMutations([correction], { distillSkill: true,
      existingSkills: [{ id: 'sk-1', name: 'npm-workflow', version: 2, triggerActionKeys: ['a-fail'] }],
    })
    expect(proposal?.target).toBe('skill-update')
    const change = proposal?.proposedChange as { skillId: string; fromVersion: number }
    expect(change.skillId).toBe('sk-1')
    expect(change.fromVersion).toBe(2)
  })

  it('maps failure-pattern → runtime-policy (risk 5)', () => {
    const pattern = stored(finalizeCandidate({
      kind: 'failure-pattern', sessionId: 's1', outcome: 'failure', compatibility: {},
      payload: {
        signature: 'sig', kind: 'repeated-error', repeats: 3,
        description: 'same error repeated 3 times', recommendedAction: 'STRATEGY_RESET',
      },
    }), 'exp-pat')
    const [proposal] = planMutations([pattern])
    expect(proposal?.target).toBe('runtime-policy')
    expect(proposal?.riskLevel).toBe(5)
  })

  it('skips rejected/deprecated experiences and duplicate proposals', () => {
    const fact = stored(finalizeCandidate({
      kind: 'fact', sessionId: 's1', outcome: 'neutral', compatibility: {},
      payload: { subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' },
    }), 'exp-fact')
    const first = planMutations([fact])
    const second = planMutations([fact], { existingProposals: first })
    expect(second).toHaveLength(0)
    const rejected = { ...fact, status: 'REJECTED' as const }
    expect(planMutations([rejected])).toHaveLength(0)
  })
})

describe('mutation registry', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function makeRegistry(): Promise<MutationRegistry> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-mut-'))
    dirs.push(dir)
    return new MutationRegistry(dir)
  }

  function proposal(target: MutationProposal['target']): MutationProposal {
    return {
      id: `mut_${target.replaceAll('-', '')}1`,
      sourceExperienceIds: ['exp-1'],
      target,
      riskLevel: TARGET_RISK[target],
      proposedChange: { kind: 'x' },
      evidence: { sessions: 2, occurrences: 3, successfulOccurrences: 2, failedOccurrences: 1, confidence: 0.6 },
      status: 'DISCOVERED',
      version: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
  }

  it('registers proposals idempotently (deterministic ids)', async () => {
    const registry = await makeRegistry()
    const first = await registry.register([proposal('memory')])
    const second = await registry.register([proposal('memory')])
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    expect((await registry.list())).toHaveLength(1)
  })

  it('enforces legal transitions and records history', async () => {
    const registry = await makeRegistry()
    await registry.register([proposal('skill-create')])
    await registry.transition('mut_skillcreate1', 'CANDIDATE', 'evidence met')
    await registry.transition('mut_skillcreate1', 'VALIDATING')
    await expect(registry.transition('mut_skillcreate1', 'ACTIVE', 'no gate check here')).resolves.toBeDefined()
    const stored = await registry.getById('mut_skillcreate1')
    expect(stored?.status).toBe('ACTIVE')
    expect(stored?.history.length).toBe(4)
    expect(legalTransition('ACTIVE', 'REJECTED')).toBe(false) // must deprecate first
    await registry.deprecate('mut_skillcreate1', 'outdated')
    expect((await registry.getById('mut_skillcreate1'))?.status).toBe('DEPRECATED')
  })

  it('promotes with gate enforcement: confirm needs a human approver', async () => {
    const registry = await makeRegistry()
    await registry.register([proposal('skill-create')])
    await registry.transition('mut_skillcreate1', 'CANDIDATE')
    await expect(
      registry.promote('mut_skillcreate1', { gate: 'confirm', validationPassed: true, approver: 'auto' }),
    ).rejects.toThrow(/human decision/)
    const promoted = await registry.promote('mut_skillcreate1', { gate: 'confirm', validationPassed: true, approver: 'user' })
    expect(promoted.status).toBe('ACTIVE')
    expect(promoted.version).toBe(2)
    expect(promoted.activatedAt).toBeDefined()
  })

  it('rolls back an ACTIVE mutation to CANDIDATE with a trace', async () => {
    const registry = await makeRegistry()
    await registry.register([proposal('runtime-policy')])
    await registry.transition('mut_runtimepolicy1', 'CANDIDATE')
    await registry.promote('mut_runtimepolicy1', { gate: 'eval-shadow-rollback', validationPassed: true, approver: 'policy' })
    const rolled = await registry.rollback('mut_runtimepolicy1', 'regression observed')
    expect(rolled.status).toBe('CANDIDATE')
    expect(rolled.version).toBe(3)
    expect(rolled.history.some(entry => entry.reason?.includes('rollback'))).toBe(true)
  })
})
