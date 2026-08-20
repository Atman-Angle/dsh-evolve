/**
 * Collective Evolution Flywheel (v0.2 demo, spec §30).
 *
 * Local Experience → Privacy Compiler → Capsule (no user/repo/path/prompt/
 * code/raw output) → Contribution staging → another dsh-evolve instance
 * auto-syncs (verify) → the experience enters SHADOW → local outcome supports
 * it → promote locally.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalizeCandidate } from '../src/experience/normalizer.js'
import type { ExperienceRecord } from '../src/experience/contracts.js'
import { compileExperience, compileMany } from '../src/privacy/compiler.js'
import { prepareContribution } from '../src/commons/contribution.js'
import { sha256 } from '../src/commons/verifier.js'
import { SyncEngine } from '../src/commons/sync.js'
import type { CommonsManifest } from '../src/commons/manifest.js'
import { shadowRun } from '../src/validation/shadow.js'

const EVIDENCE = { sessions: 4, occurrences: 6, successfulOccurrences: 5, failedOccurrences: 1, confidence: 0.8 }

function stored(candidate: ReturnType<typeof finalizeCandidate>, id: string): ExperienceRecord {
  return {
    ...candidate,
    id,
    status: 'CANDIDATE',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    sessionIds: ['s1', 's2', 's3', 's4'],
    evidence: EVIDENCE,
    provenance: { origin: { local: true }, version: 1 },
  }
}

describe('collective evolution flywheel (commons demo)', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  it('compiles, contributes, syncs, and shadows a capsule without leaking L0', async () => {
    // --- Local private experience (would contain repo/user/path details). ---
    const record = stored(finalizeCandidate({
      kind: 'correction', sessionId: 's1', outcome: 'success',
      compatibility: { task: { domain: 'coding', language: 'typescript' } },
      payload: {
        context: 'private context with C:\\Users\\alice\\projects\\nexora and github.com/acme/nexora',
        failed: { tool: 'bash', actionKey: 'k-fail', args: '{"command":"npm install"}' },
        succeeded: { tool: 'bash', actionKey: 'k-ok', args: '{"command":"pnpm install"}' },
        failureKeys: ['f1'],
      },
    }), 'exp-corr')

    // --- Privacy Compiler: L1 → L2 capsule. ---
    const compiled = compileExperience(record)
    expect(compiled.ok).toBe(true)
    const capsule = compiled.capsule!
    // No PII in the compiled content (paths/repo/email were dropped by
    // canonicalization; the safety-net scan also passes).
    expect(compiled.piiHits).toHaveLength(0)
    expect(compiled.secretHits).toHaveLength(0)
    const capsuleText = JSON.stringify(capsule)
    expect(capsuleText).not.toContain('alice')
    expect(capsuleText).not.toContain('nexora')
    expect(capsuleText).not.toContain('Users')
    expect(capsuleText).not.toContain('github.com')
    expect(capsule.privacy.rawSession).toBe(false)
    expect(capsule.privacy.freeText).toBe(false)

    // --- Contribution staging (manual, opt-in). ---
    const contribRoot = await mkdtemp(join(tmpdir(), 'dsh-evolve-collective-'))
    dirs.push(contribRoot)
    const bundle = await prepareContribution([capsule], { root: contribRoot, release: '2025-01-15' })
    expect(bundle.files).toHaveLength(1)
    expect(bundle.files[0]!.content).not.toContain('exp-corr') // local id stripped

    // --- Another instance auto-syncs (manifest → download → verify). ---
    const stagedContent = bundle.files[0]!.content
    const manifest: CommonsManifest = {
      schema: 'evolve-commons/manifest', version: '1.0.0', schemaVersion: 'evolve/v1',
      release: '2025-01-15', publishedAt: '2025-01-15T00:00:00Z',
      entries: [{ id: capsule.hash.slice(0, 16), kind: 'correction', hash: sha256(stagedContent), path: bundle.files[0]!.path }],
    }
    const otherRoot = await mkdtemp(join(tmpdir(), 'dsh-evolve-other-'))
    dirs.push(otherRoot)
    const files = new Map<string, string>([
      ['https://commons.local/index.json', JSON.stringify(manifest)],
      [`https://commons.local/${bundle.files[0]!.path}`, stagedContent],
    ])
    const engine = new SyncEngine(otherRoot, async url => {
      const content = files.get(url)
      if (content === undefined) throw new Error(`no fixture for ${url}`)
      return content
    })
    const sync = await engine.sync('https://commons.local/index.json', { force: true })
    expect(sync.updated).toBe(true)
    const view = await engine.registryView()
    expect(view[0]?.status).toBe('DOWNLOADED') // never ACTIVE from sync alone

    // --- The downloaded experience enters SHADOW; local outcome supports it. ---
    const shadow = shadowRun({ id: view[0]!.id, sourceExperienceIds: [], target: 'skill-create', riskLevel: 3, proposedChange: {}, evidence: EVIDENCE, status: 'CANDIDATE', version: 1, createdAt: 't', updatedAt: 't' }, {
      text: 'install the project dependencies',
      tools: ['bash'],
      language: 'typescript',
    })
    expect(shadow.wouldDo).toContain('skill')
    expect(shadow.agreed).toBeUndefined() // outcome not yet recorded
  })

  it('compileMany rejects non-shareable kinds with reasons', () => {
    const pref = stored(finalizeCandidate({
      kind: 'preference', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: { preference: 'pnpm over npm', scope: 'workspace' },
    }), 'exp-pref')
    const { capsules, failures } = compileMany([pref])
    expect(capsules).toHaveLength(0)
    expect(failures[0]?.errors.join(' ')).toContain('never shareable')
  })
})
