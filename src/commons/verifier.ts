/**
 * Commons verifier (v0.2, spec §21 — Verify, §23).
 *
 * Remote content is never trusted: every downloaded entry is hash-verified
 * against the manifest, schema-validated, and PII/secret-scanned before it may
 * enter the local registry (AVAILABLE → DOWNLOADED only).
 *
 * @module dsh-evolve/commons/verifier
 */

import { createHash } from 'node:crypto'
import type { ExperienceCapsule } from '../privacy/capsule.js'
import { capsuleHash } from '../privacy/capsule.js'
import { validateCapsule, type SchemaValidationResult } from '../security/schema-validator.js'
import { scanObjectPii } from '../privacy/pii-filter.js'
import { scanObjectSecrets } from '../privacy/secret-filter.js'

export type VerifyStatus = 'ok' | 'hash-mismatch' | 'schema-invalid' | 'privacy-hit'

export interface VerifyResult {
  status: VerifyStatus
  detail: string
}

/** SHA-256 hex of a downloaded payload (the manifest's `hash` field). */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Hash-verify a downloaded entry against its manifest hash. */
export function verifyHash(content: string, expectedHash: string): boolean {
  return sha256(content) === expectedHash
}

/**
 * Full verification chain for a downloaded capsule (schema + privacy; the
 * content-hash check is done by the caller against the RAW downloaded bytes,
 * since re-serialization may differ in formatting).
 */
export function verifyCapsule(
  capsule: unknown,
): VerifyResult {
  const schema: SchemaValidationResult = validateCapsule(capsule)
  if (!schema.ok) {
    return { status: 'schema-invalid', detail: schema.errors.join('; ') }
  }
  const pii = scanObjectPii(capsule)
  const secrets = scanObjectSecrets(capsule)
  if (pii.length > 0 || secrets.length > 0) {
    return {
      status: 'privacy-hit',
      detail: [...pii.map(hit => hit.kind), ...secrets.map(hit => hit.kind)].join(', '),
    }
  }
  return { status: 'ok', detail: 'verified' }
}

/** Verify an already-parsed capsule's own hash matches its content. */
export function verifyCapsuleIntegrity(capsule: ExperienceCapsule): boolean {
  return capsule.hash === capsuleHash(capsule)
}
