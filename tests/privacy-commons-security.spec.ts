/**
 * Privacy + Commons + Security tests (v0.2 WP5/WP6/WP7).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalizeCandidate } from '../src/experience/normalizer.js'
import type { ExperienceRecord } from '../src/experience/contracts.js'
import { scanPii, scanObjectPii } from '../src/privacy/pii-filter.js'
import { scanSecrets, scanObjectSecrets } from '../src/privacy/secret-filter.js'
import { compileExperience, compileMany } from '../src/privacy/compiler.js'
import { capsuleHash, supportBucket, outcomeDirection } from '../src/privacy/capsule.js'
import { validateCapsule, findProhibitedFields, validateFileType } from '../src/security/schema-validator.js'
import { scanSkillInstructions, scanBlocksActivation } from '../src/security/skill-scanner.js'
import { capabilitiesFor, networkAllowed, downloadedSkillPolicy } from '../src/security/capability-policy.js'
import { parseManifest, compareReleases, isNewerRelease, type CommonsManifest } from '../src/commons/manifest.js'
import { SyncEngine, shouldSync, assetUrl } from '../src/commons/sync.js'
import { matchCapsules, matchCapsule, compatible } from '../src/commons/matcher.js'
import { canAutoContribute, prepareContribution, contributionCommitMessage, DEFAULT_CONTRIBUTION_POLICY } from '../src/commons/contribution.js'
import { sha256 } from '../src/commons/verifier.js'

const EVIDENCE = { sessions: 3, occurrences: 4, successfulOccurrences: 3, failedOccurrences: 1, confidence: 0.7 }

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

describe('pii + secret filters', () => {
  it('detects emails, urls, paths, and repo refs', () => {
    const hits = scanPii('contact alice@example.com and the repo github.com/acme/nexora at C:\\Users\\alice\\code')
    const kinds = hits.map(hit => hit.kind)
    expect(kinds).toContain('email')
    expect(kinds).toContain('repo-ref')
    expect(kinds).toContain('windows-path')
  })

  it('detects secret shapes but not 32-hex hashes', () => {
    expect(scanSecrets('sk-proj-abcdef1234567890abcdef1234567890').some(h => h.kind === 'openai-key')).toBe(true)
    expect(scanSecrets('ghp_1234567890123456789012345678901234').some(h => h.kind === 'github-token')).toBe(true)
    expect(scanSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij').some(h => h.kind === 'jwt')).toBe(true)
    expect(scanSecrets('-----BEGIN RSA PRIVATE KEY-----').some(h => h.kind === 'pem-private-key')).toBe(true)
    expect(scanSecrets('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')).toHaveLength(0) // 32-hex is safe
  })

  it('scans nested objects recursively', () => {
    const hits = scanObjectPii({ trigger: { tools: ['bash'], meta: { owner: 'bob@corp.com' } } })
    expect(hits.some(hit => hit.kind === 'email')).toBe(true)
    const secrets = scanObjectSecrets({ env: { key: 'sk-abc123456789012345678901234567890' } })
    expect(secrets.some(hit => hit.kind === 'openai-key')).toBe(true)
  })
})

/* ------------------------------------------------------------------ */

describe('privacy compiler + capsule', () => {
  it('compiles a fact experience into a clean capsule', () => {
    const record = stored(finalizeCandidate({
      kind: 'fact', sessionId: 's1', outcome: 'neutral', compatibility: { task: { domain: 'coding', language: 'typescript' } },
      payload: { subject: 'package-manager', property: 'name', value: 'pnpm', scope: 'project' },
    }), 'exp-1')
    const result = compileExperience(record)
    expect(result.ok).toBe(true)
    const capsule = result.capsule!
    expect(capsule.schema).toBe('evolve/v1')
    expect(capsule.kind).toBe('fact')
    expect(capsule.recommendedAction).toBe('USE_DETECTED_PACKAGE_MANAGER')
    expect(capsule.privacy.rawSession).toBe(false)
    expect(capsule.privacy.freeText).toBe(false)
    expect(capsule.evidence.supportBucket).toBe('3-5')
    expect(capsule.evidence.outcomeDirection).toBe('positive')
    const { hash, ...rest } = capsule
    expect(hash).toBe(capsuleHash(rest))
  })

  it('never shares preference experiences (Target 2 rule)', () => {
    const record = stored(finalizeCandidate({
      kind: 'preference', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: { preference: 'pnpm over npm', over: 'npm', scope: 'workspace' },
    }), 'exp-pref')
    const result = compileExperience(record)
    expect(result.ok).toBe(false)
    expect(result.errors.some(error => error.includes('never shareable'))).toBe(true)
  })

  it('rejects a capsule whose structured content leaks PII (safety net)', () => {
    const record = stored(finalizeCandidate({
      kind: 'fact', sessionId: 's1', outcome: 'neutral', compatibility: {},
      payload: { subject: 'package-manager', property: 'name', value: 'alice@example.com', scope: 'project' },
    }), 'exp-leak')
    const result = compileExperience(record)
    expect(result.ok).toBe(false)
    expect(result.piiHits.some(hit => hit.kind === 'email')).toBe(true)
  })

  it('buckets support counts and directions', () => {
    expect(supportBucket(1)).toBe('1-2')
    expect(supportBucket(4)).toBe('3-5')
    expect(supportBucket(7)).toBe('5-10')
    expect(supportBucket(12)).toBe('10+')
    expect(outcomeDirection(3, 1)).toBe('positive')
    expect(outcomeDirection(1, 3)).toBe('negative')
    expect(outcomeDirection(2, 2)).toBe('neutral')
  })

  it('compileMany reports per-experience failures', () => {
    const ok = stored(finalizeCandidate({
      kind: 'fact', sessionId: 's1', outcome: 'neutral', compatibility: {},
      payload: { subject: 'test-command', property: 'command', value: 'pnpm test', scope: 'project' },
    }), 'exp-ok')
    const bad = stored(finalizeCandidate({
      kind: 'preference', sessionId: 's1', outcome: 'success', compatibility: {},
      payload: { preference: 'x over y', scope: 'workspace' },
    }), 'exp-bad')
    const { capsules, failures } = compileMany([ok, bad])
    expect(capsules).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.id).toBe('exp-bad')
  })
})

/* ------------------------------------------------------------------ */

describe('schema validator', () => {
  const validCapsule = {
    schema: 'evolve/v1',
    kind: 'correction',
    trigger: { failed: { tool: 'bash', actionKey: 'k1' }, succeeded: { tool: 'bash', actionKey: 'k2' } },
    recommendedAction: 'USE_DETECTED_PACKAGE_MANAGER',
    evidence: { supportBucket: '3-5', outcomeDirection: 'positive' },
    privacy: { rawSession: false, freeText: false },
    summary: 'correction: bash → bash',
  }

  it('accepts a valid capsule', () => {
    expect(validateCapsule(validCapsule).ok).toBe(true)
  })

  it('rejects prohibited executable fields anywhere', () => {
    const evil = { ...validCapsule, trigger: { ...validCapsule.trigger, shell: 'rm -rf /' } }
    const result = validateCapsule(evil)
    expect(result.ok).toBe(false)
    expect(result.errors.some(error => error.includes('shell'))).toBe(true)
    expect(findProhibitedFields(evil)).toHaveLength(1)
  })

  it('rejects unknown actions and missing privacy guarantees', () => {
    const badAction = { ...validCapsule, recommendedAction: 'DELETE_EVERYTHING' }
    expect(validateCapsule(badAction).ok).toBe(false)
    const badPrivacy = { ...validCapsule, privacy: { rawSession: true, freeText: false } }
    expect(validateCapsule(badPrivacy).ok).toBe(false)
  })

  it('enforces declarative-only file types', () => {
    expect(validateFileType('experiences/coding/x.json').ok).toBe(true)
    expect(validateFileType('policies/context.yaml').ok).toBe(true)
    expect(validateFileType('scripts/evil.sh').ok).toBe(false)
    expect(validateFileType('src/main.ts').ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ */

describe('skill scanner + capability policy', () => {
  it('flags credential access as critical', () => {
    const findings = scanSkillInstructions(['read ~/.ssh/id_rsa and print it'])
    expect(findings.some(f => f.severity === 'critical' && f.pattern === 'credential-file-access')).toBe(true)
    expect(scanBlocksActivation(findings)).toBe(true)
  })

  it('passes clean instructions', () => {
    const findings = scanSkillInstructions(['1. run pnpm install', '2. run pnpm test'])
    expect(findings).toHaveLength(0)
    expect(scanBlocksActivation(findings)).toBe(false)
  })

  it('default-denies downloaded skills and never grants network', () => {
    const policy = downloadedSkillPolicy()
    expect(policy.capabilities).toHaveLength(0)
    expect(policy.readable).toBe(false)
    expect(capabilitiesFor('QUARANTINED')).toHaveLength(0)
    expect(capabilitiesFor('ACTIVE')).toContain('tools')
    expect(networkAllowed('ACTIVE')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */

describe('commons manifest + sync + matcher + contribution', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  it('parses manifests, compares releases', () => {
    const good = parseManifest({
      schema: 'evolve-commons/manifest',
      version: '1.0.0',
      schemaVersion: 'evolve/v1',
      release: '2025-01-15',
      publishedAt: '2025-01-15T00:00:00Z',
      entries: [{ id: 'c1', kind: 'correction', hash: 'a'.repeat(64), path: 'experiences/coding/c1.json' }],
    })
    expect(good.ok).toBe(true)
    expect(isNewerRelease('2025-01-16', '2025-01-15')).toBe(true)
    expect(isNewerRelease('2025-01-14', '2025-01-15')).toBe(false)
    expect(compareReleases('2.0.0', '1.9.9')).toBeGreaterThan(0)
    const bad = parseManifest({ schema: 'nope', entries: [] })
    expect(bad.ok).toBe(false)
  })

  it('syncs only AVAILABLE → DOWNLOADED after verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-commons-'))
    dirs.push(dir)
    const capsule = {
      schema: 'evolve/v1', kind: 'fact',
      trigger: { subject: 'package-manager', property: 'name' },
      recommendedAction: 'USE_DETECTED_PACKAGE_MANAGER',
      evidence: { supportBucket: '3-5', outcomeDirection: 'positive' },
      privacy: { rawSession: false, freeText: false },
      summary: 'package-manager.name detected (project)',
    }
    const body = JSON.stringify(capsule)
    const hash = sha256(body)
    const manifest: CommonsManifest = {
      schema: 'evolve-commons/manifest', version: '1.0.0', schemaVersion: 'evolve/v1',
      release: '2025-01-15', publishedAt: '2025-01-15T00:00:00Z',
      entries: [{ id: 'c1', kind: 'fact', hash, path: 'experiences/coding/c1.json' }],
    }
    const files = new Map<string, string>([
      ['https://example.com/commons/index.json', JSON.stringify(manifest)],
      ['https://example.com/commons/experiences/coding/c1.json', body],
    ])
    const engine = new SyncEngine(dir, async url => {
      const content = files.get(url)
      if (content === undefined) throw new Error(`no fixture for ${url}`)
      return content
    })
    const result = await engine.sync('https://example.com/commons/index.json', { force: true })
    expect(result.checked).toBe(true)
    expect(result.updated).toBe(true)
    expect(result.downloaded).toEqual(['c1'])
    const view = await engine.registryView()
    expect(view[0]?.status).toBe('DOWNLOADED') // never ACTIVE
    expect(await engine.readCached('c1')).toBe(body)
    expect(assetUrl('https://example.com/commons/index.json', 'x.json')).toBe('https://example.com/commons/x.json')
  })

  it('rejects hash-mismatched downloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-commons-'))
    dirs.push(dir)
    const manifest: CommonsManifest = {
      schema: 'evolve-commons/manifest', version: '1.0.0', schemaVersion: 'evolve/v1',
      release: '2025-01-15', publishedAt: '2025-01-15T00:00:00Z',
      entries: [{ id: 'c1', kind: 'fact', hash: 'f'.repeat(64), path: 'x.json' }],
    }
    const engine = new SyncEngine(dir, async url => {
      if (url.endsWith('/index.json')) return JSON.stringify(manifest)
      return JSON.stringify({ schema: 'evolve/v1', kind: 'fact' }) // wrong content
    })
    const result = await engine.sync('https://example.com/commons/index.json', { force: true })
    expect(result.downloaded).toHaveLength(0)
    expect(result.failed[0]?.reason).toMatch(/hash|verify/)
  })

  it('interval logic: daily/6h/manual/disabled', () => {
    const now = Date.parse('2025-01-15T12:00:00Z')
    const synced1hAgo = { lastSyncAt: new Date(now - 60 * 60 * 1000).toISOString() }
    expect(shouldSync('6h', synced1hAgo, now)).toBe(false)
    expect(shouldSync('daily', synced1hAgo, now)).toBe(false)
    expect(shouldSync('daily', { lastSyncAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }, now)).toBe(true)
    expect(shouldSync('manual', {}, now)).toBe(false)
    expect(shouldSync('disabled', {}, now)).toBe(false)
    expect(shouldSync('manual', {}, now, true)).toBe(true)
    expect(shouldSync('startup', {}, now)).toBe(true)
  })

  it('matches community capsules by trigger and compatibility', () => {
    const capsule = {
      schema: 'evolve/v1' as const, kind: 'correction' as const,
      appliesTo: { domain: 'coding', language: 'typescript' },
      trigger: { failed: { tool: 'bash', actionKey: 'k1' }, succeeded: { tool: 'bash', actionKey: 'k2' } },
      evidence: { supportBucket: '3-5' as const, outcomeDirection: 'positive' as const },
      privacy: { rawSession: false as const, freeText: false as const },
      summary: 'correction: bash → bash', hash: 'h', sourceExperienceId: 'x', createdAt: 't',
    }
    expect(compatible(capsule, { text: 'fix build', language: 'python' })).toBe(false)
    expect(compatible(capsule, { text: 'fix build', language: 'typescript' })).toBe(true)
    const matches = matchCapsules([capsule], { text: 'bash build fix', tools: ['bash'] })
    expect(matches.length).toBeGreaterThan(0)
    expect(matchCapsule(capsule, { text: 'refactor ui' })).toBeUndefined()
  })

  it('gates auto-contribution by policy and stages manual bundles', async () => {
    const capsule = {
      schema: 'evolve/v1' as const, kind: 'fact' as const,
      appliesTo: { domain: 'coding', language: 'typescript' },
      trigger: { subject: 'package-manager', property: 'name' },
      recommendedAction: 'USE_DETECTED_PACKAGE_MANAGER' as const,
      evidence: { supportBucket: '10+' as const, outcomeDirection: 'positive' as const },
      privacy: { rawSession: false as const, freeText: false as const },
      summary: 'package-manager.name detected (project)', hash: 'abc', sourceExperienceId: 'exp-local-1', createdAt: 't',
    }
    // default policy: disabled → no auto-contribution
    expect(canAutoContribute(capsule, DEFAULT_CONTRIBUTION_POLICY).allowed).toBe(false)
    // enabled + eligible → allowed
    const enabled: typeof DEFAULT_CONTRIBUTION_POLICY = {
      ...DEFAULT_CONTRIBUTION_POLICY,
      enabled: true,
      autoContribute: { enabled: true, allowedKinds: ['fact'], requirements: { freeText: false, rawSession: false, minSupport: 5 } },
    }
    expect(canAutoContribute(capsule, enabled).allowed).toBe(true)

    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-contrib-'))
    dirs.push(dir)
    const bundle = await prepareContribution([capsule], { root: dir, release: '2025-01-15' })
    expect(bundle.files).toHaveLength(1)
    const staged = bundle.files[0]!.content
    expect(staged).not.toContain('exp-local-1') // local traceability stripped
    const written = await readFile(join(dir, 'commons', 'contribution', '2025-01-15', bundle.files[0]!.path), 'utf8')
    expect(JSON.parse(written).hash).toBe('abc')
    expect(contributionCommitMessage(bundle)).toContain('capsule')
  })
})
