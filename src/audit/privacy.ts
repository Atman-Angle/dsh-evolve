/**
 * Privacy adversarial audit (v0.2 release hardening, spec §十五).
 *
 * Constructs a session packed with sensitive content (email, phone, user name,
 * absolute paths, repo/org names, GitHub URL, API key, JWT, PEM, access token,
 * source code, raw prompt, raw tool output), runs it through the full pipeline
 * (Session → Episode → Experience → Privacy Compiler → Capsule) and verifies:
 *
 *   - fail-loud: crafted experiences whose structured payload carries
 *     sensitive content are REJECTED (never auto-scrubbed-and-uploaded);
 *   - defense in depth: whatever capsule IS produced contains none of the
 *     sensitive strings, and privacy.rawSession/freeText are false.
 *
 * @module dsh-evolve/audit/privacy
 */

import type { CollectorEvent } from '../contracts/trajectory.js'
import type { AuditCheck } from './contracts.js'
import { extractEpisodes } from '../episode/extractor.js'
import { mineEpisode } from '../experience/miner.js'
import { finalizeCandidate } from '../experience/normalizer.js'
import { compileMany, compileExperience } from '../privacy/compiler.js'
import type { ExperienceRecord } from '../experience/contracts.js'

/** Sensitive strings that must never appear in a capsule. */
const SENSITIVE = [
  'alice@example.com',
  '+1-555-0100',
  'C:\\Users\\alice\\projects\\nexora',
  '/home/alice/projects/nexora',
  'nexora',
  'acme-corp',
  'github.com/acme/nexora',
  'sk-proj-abcdef1234567890abcdef1234567890',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij',
  'BEGIN RSA PRIVATE KEY',
  'ghp_1234567890123456789012345678901234',
]

/** An adversarial session whose tool outputs carry sensitive content. */
export function adversarialSessionEvents(): CollectorEvent[] {
  return [
    { type: 'user/message', sourceKind: 'user', text: 'fix the build for nexora, contact alice@example.com or +1-555-0100' },
    { type: 'step/start', turn: 1, step: 1 },
    {
      type: 'tool/call',
      data: { name: 'bash', arguments: '{"command":"cat /home/alice/projects/nexora/src/a.ts"}', turn: 1, step: 1 },
    },
    {
      type: 'tool/result',
      data: {
        isError: false,
        contentText: '// source code with secret sk-proj-abcdef1234567890abcdef1234567890 and github.com/acme/nexora\nconst key = "ghp_1234567890123456789012345678901234"',
        turn: 1,
        step: 1,
      },
    },
    { type: 'step/end', turn: 1, step: 1 },
    { type: 'step/start', turn: 2, step: 1 },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"npm install"}', turn: 2, step: 1 } },
    {
      type: 'tool/result',
      data: {
        isError: true,
        error: { name: 'Error', code: 'E404', text: 'no package at C:\\Users\\alice\\projects\\nexora' },
        contentText: 'npm ERR! no package at C:\\Users\\alice\\projects\\nexora',
        turn: 2,
        step: 1,
      },
    },
    { type: 'step/end', turn: 2, step: 1 },
    { type: 'user/message', sourceKind: 'user', text: 'use pnpm (token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij, pem: -----BEGIN RSA PRIVATE KEY-----)' },
    { type: 'step/start', turn: 3, step: 1 },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm install"}', turn: 3, step: 1 } },
    { type: 'tool/result', data: { isError: false, contentText: 'added 42 packages', turn: 3, step: 1 } },
    { type: 'step/end', turn: 3, step: 1 },
    { type: 'turn/end', reasonKind: 'turn_completed' },
  ]
}

function stored(candidate: ReturnType<typeof finalizeCandidate>, id: string): ExperienceRecord {
  return {
    ...candidate,
    id,
    status: 'CANDIDATE',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    sessionIds: ['adversarial-session'],
    evidence: { sessions: 1, occurrences: 1, successfulOccurrences: 1, failedOccurrences: 0, confidence: 0.5 },
    provenance: { origin: { local: true }, version: 1 },
  }
}

/** Run the adversarial privacy pipeline check. */
export async function runPrivacyAdversarial(): Promise<{ pass: boolean; detail: string }> {
  const failures: string[] = []

  // 1. Adversarial session → mining → compilation. No capsule may leak.
  const sessionId = 'adversarial-session'
  const episodes = extractEpisodes(sessionId, adversarialSessionEvents())
  const candidates = episodes.flatMap(episode => mineEpisode(episode, sessionId))
  const records = candidates.map((candidate, index) => stored(candidate, `exp-adv-${index}`))
  const { capsules, failures: rejected } = compileMany(records)
  const capsuleText = JSON.stringify(capsules)
  for (const sensitive of SENSITIVE) {
    if (capsuleText.includes(sensitive)) {
      failures.push(`capsule leaked sensitive content: ${sensitive.slice(0, 40)}`)
    }
  }
  if (capsules.some(capsule => capsule.privacy.rawSession !== false || capsule.privacy.freeText !== false)) {
    failures.push('capsule privacy flags not false')
  }
  // Some adversarial experiences SHOULD be rejected (fail-loud), not scrubbed.
  const rejections = rejected.length
  if (rejections === 0) failures.push('expected at least one fail-loud rejection for adversarial content')

  // 2. A crafted experience whose structured payload carries an API key must
  //    be REJECTED by the compiler (never silently scrubbed).
  const leaky = stored(finalizeCandidate({
    kind: 'fact', sessionId, outcome: 'neutral', compatibility: {},
    payload: { subject: 'package-manager', property: 'name', value: 'sk-proj-abcdef1234567890abcdef1234567890', scope: 'project' },
  }), 'exp-leaky')
  const leakyResult = compileExperience(leaky)
  if (leakyResult.ok) failures.push('leaky structured fact was accepted (should be fail-loud rejected)')

  return {
    pass: failures.length === 0,
    detail: failures.length === 0
      ? `${capsules.length} capsule(s) clean, ${rejections} fail-loud rejection(s)`
      : failures.join('; '),
  }
}

/** Run the privacy adversarial audit check. */
export async function auditPrivacy(): Promise<AuditCheck> {
  const result = await runPrivacyAdversarial()
  return {
    id: 'privacy-adversarial',
    name: 'Privacy adversarial (fail-loud, no L0 leakage)',
    scope: 'privacy',
    verdict: result.pass ? 'PASS' : 'FAIL',
    detail: result.detail,
    evidence: { sensitiveCount: SENSITIVE.length },
  }
}
