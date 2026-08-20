/**
 * Schema validator (v0.2, spec §16, §15).
 *
 * Enforces the evolve/v1 capsule schema: required fields, closed enums,
 * prohibited fields (shell/exec/eval/http_request/prompt/system_instruction/
 * code/script), and schema-defined actions only. Commons PRs may only carry
 * declarative data — executable file types are rejected.
 *
 * @module dsh-evolve/security/schema-validator
 */

import { ALLOWED_ACTIONS, PROHIBITED_FIELDS, isAllowedAction } from '../contracts/actions.js'

export const CAPSULE_KINDS = ['fact', 'correction', 'procedural', 'failure-pattern'] as const
export const SUPPORT_BUCKETS = ['1-2', '3-5', '5-10', '10+'] as const
export const OUTCOME_DIRECTIONS = ['positive', 'negative', 'neutral'] as const

export interface SchemaValidationResult {
  ok: boolean
  errors: string[]
}

/** Recursively find any prohibited field key (e.g. `shell`, `eval`). */
export function findProhibitedFields(value: unknown, path = ''): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) {
    value.forEach((entry, index) => hits.push(...findProhibitedFields(entry, `${path}[${index}]`)))
    return hits
  }
  if (value === null || typeof value !== 'object') return hits
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const full = path === '' ? key : `${path}.${key}`
    if ((PROHIBITED_FIELDS as readonly string[]).includes(key.toLowerCase())) hits.push(full)
    hits.push(...findProhibitedFields((value as Record<string, unknown>)[key], full))
  }
  return hits
}

/** Suspicious string values that a declarative capsule must never carry
 * (file://, path traversal, code-execution markers, credential paths, and
 * binary-looking blobs). Defense in depth on top of the field allowlist. */
const SUSPICIOUS_VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /file:\/\//i, label: 'file-protocol' },
  { pattern: /\.\.(\/|\\)/, label: 'path-traversal' },
  { pattern: /\beval\s*\(/, label: 'eval-call' },
  { pattern: /\bFunction\s*\(/, label: 'function-constructor' },
  { pattern: /\bprocess\s*\./, label: 'process-access' },
  { pattern: /\brequire\s*\(/, label: 'require-call' },
  { pattern: /[~]\/\.(?:ssh|aws|gnupg)\b/, label: 'credential-path' },
  { pattern: /\.(?:ssh|aws|gnupg)[\\/]/, label: 'credential-path' },
  { pattern: /[\u0000-\u0008\u000e-\u001f]/, label: 'control-chars' },
]

/** Binary-blob detection: long base64 that contains at least one non-hex
 * character (so 32-char hex hashes like action keys never false-positive). */
function looksLikeBinaryBlob(value: string): boolean {
  if (value.length < 36) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  return /[+/g-zG-Z]/.test(value)
}

/** Recursively scan every string value for suspicious content. */
export function findSuspiciousValues(value: unknown, path = ''): string[] {
  const hits: string[] = []
  const walk = (entry: unknown, current: string): void => {
    if (typeof entry === 'string') {
      for (const detector of SUSPICIOUS_VALUE_PATTERNS) {
        if (detector.pattern.test(entry)) {
          hits.push(`${current}(${detector.label})`)
          break
        }
      }
      if (looksLikeBinaryBlob(entry)) hits.push(`${current}(binary-blob)`)
    } else if (Array.isArray(entry)) {
      entry.forEach((item, index) => walk(item, `${current}[${index}]`))
    } else if (entry !== null && typeof entry === 'object') {
      for (const key of Object.keys(entry as Record<string, unknown>)) {
        walk((entry as Record<string, unknown>)[key], current === '' ? key : `${current}.${key}`)
      }
    }
  }
  walk(value, path)
  return hits
}

/** Validate a parsed capsule document against evolve/v1. */
export function validateCapsule(value: unknown): SchemaValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { ok: false, errors: ['capsule must be an object'] }
  }
  const capsule = value as Record<string, unknown>

  if (capsule['schema'] !== 'evolve/v1') errors.push('schema must be evolve/v1')
  const kind = capsule['kind']
  if (typeof kind !== 'string' || !(CAPSULE_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind must be one of ${CAPSULE_KINDS.join('|')}`)
  }
  if (capsule['trigger'] === null || typeof capsule['trigger'] !== 'object' || Array.isArray(capsule['trigger'])) {
    errors.push('trigger must be a structured object')
  }
  if (typeof capsule['summary'] !== 'string' || capsule['summary'].length > 160) {
    errors.push('summary must be a string ≤ 160 chars')
  }
  const action = capsule['recommendedAction']
  if (action !== undefined && !isAllowedAction(action)) {
    errors.push(`recommendedAction must be one of ${ALLOWED_ACTIONS.join('|')}`)
  }

  const evidence = capsule['evidence'] as Record<string, unknown> | undefined
  if (evidence === null || typeof evidence !== 'object') {
    errors.push('evidence must be an object')
  } else {
    const bucket = evidence['supportBucket']
    if (typeof bucket !== 'string' || !(SUPPORT_BUCKETS as readonly string[]).includes(bucket)) {
      errors.push(`supportBucket must be one of ${SUPPORT_BUCKETS.join('|')}`)
    }
    const direction = evidence['outcomeDirection']
    if (typeof direction !== 'string' || !(OUTCOME_DIRECTIONS as readonly string[]).includes(direction)) {
      errors.push(`outcomeDirection must be one of ${OUTCOME_DIRECTIONS.join('|')}`)
    }
  }

  const privacy = capsule['privacy'] as Record<string, unknown> | undefined
  if (privacy === null || typeof privacy !== 'object') {
    errors.push('privacy must be an object')
  } else {
    if (privacy['rawSession'] !== false) errors.push('privacy.rawSession must be false')
    if (privacy['freeText'] !== false) errors.push('privacy.freeText must be false')
  }

  const prohibited = findProhibitedFields(value)
  if (prohibited.length > 0) {
    errors.push(`prohibited field(s): ${prohibited.join(', ')}`)
  }
  const suspicious = findSuspiciousValues(value)
  if (suspicious.length > 0) {
    errors.push(`suspicious value(s): ${suspicious.join(', ')}`)
  }
  return { ok: errors.length === 0, errors }
}

/** Commons PR file-type restrictions (spec §15). */
const PROHIBITED_FILE_TYPES = ['.js', '.ts', '.py', '.sh', '.exe', '.dll', '.bat', '.ps1', '.bin', '.so', '.dylib']

export function validateFileType(filename: string): { ok: boolean; reason?: string } {
  const lower = filename.toLowerCase()
  for (const extension of PROHIBITED_FILE_TYPES) {
    if (lower.endsWith(extension)) {
      return { ok: false, reason: `prohibited file type ${extension}` }
    }
  }
  if (lower.endsWith('.json') || lower.endsWith('.yml') || lower.endsWith('.yaml') || lower.endsWith('.md')) {
    return { ok: true }
  }
  return { ok: false, reason: 'only declarative data files are allowed (.json/.yml/.md)' }
}
