/**
 * Privacy adversarial audit test (spec §十五).
 *
 * A session packed with email/phone/paths/repo/org/GitHub URL/API key/JWT/PEM/
 * token/source code/raw prompt/raw tool output must never leak into a capsule:
 * fail-loud REJECT, never silent scrub-and-upload.
 */

import { describe, expect, it } from 'vitest'
import { runPrivacyAdversarial, adversarialSessionEvents, auditPrivacy } from '../../src/audit/privacy.js'
import { extractEpisodes } from '../../src/episode/extractor.js'
import { mineEpisode } from '../../src/experience/miner.js'
import { finalizeCandidate } from '../../src/experience/normalizer.js'
import { compileExperience } from '../../src/privacy/compiler.js'

describe('privacy adversarial audit', () => {
  it('the full pipeline never leaks L0 content into a capsule', async () => {
    const result = await runPrivacyAdversarial()
    expect(result.pass).toBe(true)
  })

  it('an adversarial session produces experiences whose payloads are structural only', () => {
    const episodes = extractEpisodes('adversarial-session', adversarialSessionEvents())
    const candidates = episodes.flatMap(episode => mineEpisode(episode, 'adversarial-session'))
    // Corrections carry hash keys + tool names, never raw tool output text.
    const corrections = candidates.filter(candidate => candidate.kind === 'correction')
    expect(corrections.length).toBeGreaterThan(0)
    for (const correction of corrections) {
      const payload = JSON.stringify(correction.payload)
      expect(payload).not.toContain('ghp_')
      expect(payload).not.toContain('sk-proj-')
      expect(payload).not.toContain('C:\\Users')
    }
  })

  it('a structured payload carrying an API key is REJECTED (fail-loud)', () => {
    const record = {
      ...finalizeCandidate({
        kind: 'fact', sessionId: 's1', outcome: 'neutral', compatibility: {},
        payload: { subject: 'package-manager', property: 'name', value: 'sk-proj-abcdef1234567890abcdef1234567890', scope: 'project' },
      }),
      id: 'exp-leaky', status: 'CANDIDATE' as const,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      sessionIds: ['s1'], evidence: { sessions: 1, occurrences: 1, successfulOccurrences: 1, failedOccurrences: 0, confidence: 0.5 },
      provenance: { origin: { local: true }, version: 1 },
    }
    const result = compileExperience(record)
    expect(result.ok).toBe(false)
    expect(result.secretHits.some(hit => hit.kind === 'openai-key')).toBe(true)
  })

  it('auditPrivacy verdict is PASS', async () => {
    const check = await auditPrivacy()
    expect(check.verdict).toBe('PASS')
  })
})
