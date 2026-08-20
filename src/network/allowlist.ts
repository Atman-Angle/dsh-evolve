/**
 * Network allowlist (v0.2 release hardening, spec §十).
 *
 * Default network egress is limited to the GitHub Commons (manifest + release
 * assets) and, optionally, a configured semantic provider. Every outbound
 * request goes through the unified network client, which enforces this
 * allowlist, timeouts, rate limits, audit logging, and the circuit breaker.
 *
 * @module dsh-evolve/network/allowlist
 */

export interface NetworkPolicy {
  /** Exact hostnames allowed (lowercase, no scheme/port). */
  allowedHosts: string[]
  /** Optional semantic provider host (empty = disabled). */
  semanticProviderHost?: string
}

/** Default egress scope: GitHub Commons only. */
export const DEFAULT_ALLOWED_HOSTS = [
  'raw.githubusercontent.com',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
]

export function defaultNetworkPolicy(): NetworkPolicy {
  return { allowedHosts: [...DEFAULT_ALLOWED_HOSTS] }
}

/** Parse the hostname from a URL (throws on unparseable input). */
export function parseHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    throw new NetworkPolicyError(`unparseable URL: ${url.slice(0, 80)}`)
  }
}

export interface AllowlistVerdict {
  allowed: boolean
  reason: string
}

/** Check a URL against the policy (pure). */
export function isAllowedUrl(url: string, policy: NetworkPolicy = defaultNetworkPolicy()): AllowlistVerdict {
  let host: string
  try {
    host = parseHost(url)
  } catch (error) {
    return { allowed: false, reason: (error as Error).message }
  }
  if (policy.allowedHosts.includes(host)) return { allowed: true, reason: `host ${host} allowlisted` }
  if (policy.semanticProviderHost !== undefined && host === policy.semanticProviderHost) {
    return { allowed: true, reason: `host ${host} configured semantic provider` }
  }
  return { allowed: false, reason: `host ${host} not in network allowlist` }
}

/** Error thrown when a URL is outside the allowlist. */
export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(`dsh-evolve: network policy — ${message}`)
    this.name = 'NetworkPolicyError'
  }
}
