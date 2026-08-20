/**
 * CLI command smoke tests (v0.2 WP8): status / experience / mutations /
 * skills / capsule flows driven through the real command dispatcher.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runV02Command, parseFlags } from '../src/offline/commands.js'
import { finalizeCandidate } from '../src/experience/normalizer.js'
import { ExperienceStore } from '../src/experience/store.js'
import { MutationRegistry } from '../src/mutation/registry.js'
import { planMutations } from '../src/mutation/planner.js'

async function capture(command: string, argv: readonly string[], root: string): Promise<string> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  let captured = ''
  try {
    const code = await runV02Command(command, parseFlags([...argv, '--root', root]))
    expect(code).toBe(0)
    captured = write.mock.calls.map(call => String(call[0])).join('')
  } finally {
    write.mockRestore()
  }
  return captured
}

describe('CLI commands (v0.2)', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  async function seed(): Promise<{ root: string; skillCreateId: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-cli-'))
    dirs.push(root)
    const experiences = new ExperienceStore(root)
    // Merge the same correction three times (once per session) so evidence
    // reaches the skill-create eligibility threshold (sessions ≥ 2, x ≥ 3).
    for (const session of ['s1', 's2', 's3']) {
      await experiences.merge([finalizeCandidate({
        kind: 'correction', sessionId: session, outcome: 'success', compatibility: {},
        payload: {
          context: 'c',
          failed: { tool: 'bash', actionKey: 'k-fail', args: '{"command":"npm install"}' },
          succeeded: { tool: 'bash', actionKey: 'k-ok', args: '{"command":"pnpm install"}' },
          failureKeys: ['f1'],
        },
      })])
    }
    const mutations = new MutationRegistry(root)
    const proposals = planMutations(await experiences.list(), { distillSkill: true })
    const created = await mutations.register(proposals)
    const skillCreate = proposals.find(proposal => proposal.target === 'skill-create')
    expect(created).toContain(skillCreate!.id)
    return { root, skillCreateId: skillCreate!.id }
  }

  it('status and experience list show the mined correction', async () => {
    const { root } = await seed()
    const statusOut = await capture('status', [], root)
    expect(statusOut).toMatch(/experiences\s+1/)
    expect(statusOut).toMatch(/pending approval\s+0/)
    expect(statusOut).toContain('mode                 BALANCED')
    const listOut = await capture('experience', ['list'], root)
    expect(listOut).toContain('correction')
    const listJson = await capture('experience', ['list', '--json'], root)
    const id = (JSON.parse(listJson) as Array<{ id: string }>)[0]?.id
    expect(id).toBeDefined()
    const detail = await capture('experience', ['detail', id!], root)
    expect(detail).toContain('pnpm install')
  })

  it('mutations promote (user approval) creates a candidate skill', async () => {
    const { root, skillCreateId } = await seed()
    const out = await capture('mutations', ['promote', skillCreateId, '--approver', 'user'], root)
    expect(out).toContain('promoted')
    const skillsOut = await capture('skills', ['list'], root)
    expect(skillsOut).toContain('CANDIDATE')
  })

  it('skills activate writes an agent-visible body and capsule compile produces a preview', async () => {
    const { root, skillCreateId } = await seed()
    await capture('mutations', ['promote', skillCreateId, '--approver', 'user'], root)
    const list = await capture('skills', ['list', '--json'], root)
    const skillId = (JSON.parse(list) as Array<{ id: string }>)[0]?.id
    expect(skillId).toBeDefined()
    await capture('skills', ['activate', skillId!], root)

    const capsuleOut = await capture('capsule', ['compile', '--all', '--preview'], root)
    expect(capsuleOut).toContain('evolve/v1')
    expect(capsuleOut).toContain('correction: bash → bash')
    const capsuleList = await capture('capsule', ['list'], root)
    expect(capsuleList).toContain('correction')
  })

  it('mutations reject marks the proposal REJECTED', async () => {
    const { root, skillCreateId } = await seed()
    const out = await capture('mutations', ['reject', skillCreateId, '--reason', 'not wanted'], root)
    expect(out).toContain('rejected')
    const list = await capture('mutations', ['list', '--status', 'REJECTED'], root)
    expect(list).toContain(skillCreateId)
  })
})
