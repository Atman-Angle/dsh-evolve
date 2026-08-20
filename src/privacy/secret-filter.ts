/**
 * Secret filter (v0.2, spec §19 — Secret Scan).
 *
 * Scans capsule-bound text for credential-shaped content. Detection is
 * targeted (known vendor prefixes, PEM blocks, JWTs, sensitive key=value
 * pairs) so that harmless 32-char hex hashes (action keys) never false-positive.
 *
 * @module dsh-evolve/privacy/secret-filter
 */

export interface SecretHit {
  kind: string
  match: string
}

const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/
const GITHUB_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/
const GITHUB_FINE = /\bgithub_pat_[A-Za-z0-9_]{30,}\b/
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{20,}\b/
const STRIPE_KEY = /\bsk_live_[0-9a-zA-Z]{20,}\b/
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\b/
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const SENSITIVE_PAIR = /\b(password|passwd|pwd|api[_-]?key|token|secret|access[_-]?key)\s*[=:]\s*[^\s"'<>]{6,}/i

const DETECTORS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'openai-key', re: OPENAI_KEY },
  { kind: 'github-token', re: GITHUB_TOKEN },
  { kind: 'github-fine-grained', re: GITHUB_FINE },
  { kind: 'slack-token', re: SLACK_TOKEN },
  { kind: 'aws-key', re: AWS_KEY },
  { kind: 'google-key', re: GOOGLE_KEY },
  { kind: 'stripe-key', re: STRIPE_KEY },
  { kind: 'jwt', re: JWT },
  { kind: 'pem-private-key', re: PEM },
  { kind: 'sensitive-pair', re: SENSITIVE_PAIR },
]

/** Scan text for secret-shaped content. */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  const seen = new Set<string>()
  for (const detector of DETECTORS) {
    const re = new RegExp(detector.re.source, detector.re.flags.replace('g', ''))
    const match = text.match(re)
    if (match !== null && match[0] !== undefined) {
      const key = `${detector.kind}:${match[0]}`
      if (!seen.has(key)) {
        seen.add(key)
        hits.push({ kind: detector.kind, match: match[0].slice(0, 40) })
      }
    }
  }
  return hits
}

/** Scan every string value in a structured object (recursively). */
export function scanObjectSecrets(value: unknown, hits: SecretHit[] = []): SecretHit[] {
  if (typeof value === 'string') hits.push(...scanSecrets(value))
  else if (Array.isArray(value)) {
    for (const entry of value) scanObjectSecrets(entry, hits)
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      scanObjectSecrets((value as Record<string, unknown>)[key], hits)
    }
  }
  return hits
}
