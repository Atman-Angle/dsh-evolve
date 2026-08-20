/**
 * PII filter (v0.2, spec §19 — PII Detection / Path Removal / Repo-Org Removal).
 *
 * Detects personally identifiable or location-identifying content in any text
 * that would reach a shareable capsule. Detection is intentionally
 * conservative: a false positive rejects a capsule (safe), a false negative
 * leaks identity (unsafe).
 *
 * @module dsh-evolve/privacy/pii-filter
 */

export interface PiiHit {
  kind: string
  match: string
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const URL = /\b(https?:\/\/|www\.)[^\s"'<>]+/i
const PHONE = /\b(\+?\d{1,3}[-.\s]?)?(\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}\b(?!\d)/i
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'<>]+/
const POSIX_PATH = /\b\/(?:home|Users|workspace|projects|src|tmp|var|opt)\/[^\s"'<>]+/i
const REPO_REF = /\b(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s"'<>]+/i
const AT_HANDLE = /@[A-Za-z0-9_-]{2,}\b/
const CREDIT_CARD = /\b(?:\d[ -]?){13,19}\b/

const DETECTORS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'email', re: EMAIL },
  { kind: 'url', re: URL },
  { kind: 'phone', re: PHONE },
  { kind: 'ipv4', re: IPV4 },
  { kind: 'windows-path', re: WINDOWS_PATH },
  { kind: 'posix-path', re: POSIX_PATH },
  { kind: 'repo-ref', re: REPO_REF },
  { kind: 'at-handle', re: AT_HANDLE },
  { kind: 'credit-card', re: CREDIT_CARD },
]

/** Scan text for PII/identity hits (deduplicated by kind+match). */
export function scanPii(text: string): PiiHit[] {
  const hits: PiiHit[] = []
  const seen = new Set<string>()
  for (const detector of DETECTORS) {
    const re = new RegExp(detector.re.source, detector.re.flags.replace('g', ''))
    const match = text.match(re)
    if (match !== null && match[0] !== undefined) {
      const key = `${detector.kind}:${match[0]}`
      if (!seen.has(key)) {
        seen.add(key)
        hits.push({ kind: detector.kind, match: match[0].slice(0, 80) })
      }
    }
  }
  return hits
}

/** Scan every string value in a structured object (recursively). */
export function scanObjectPii(value: unknown, hits: PiiHit[] = []): PiiHit[] {
  if (typeof value === 'string') hits.push(...scanPii(value))
  else if (Array.isArray(value)) {
    for (const entry of value) scanObjectPii(entry, hits)
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      scanObjectPii((value as Record<string, unknown>)[key], hits)
    }
  }
  return hits
}
