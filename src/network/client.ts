/**
 * Unified network client (v0.2 release hardening, spec §十).
 *
 * THE single place that touches global fetch. All outbound evolve traffic
 * (Commons manifest/assets, optional semantic provider) flows through here so
 * that allowlist, timeout, rate limit, audit log, and circuit breaker are
 * enforced uniformly. Feature modules (experience/skill/privacy/mutation) must
 * never call fetch directly.
 *
 * @module dsh-evolve/network/client
 */

import { CircuitBreaker } from '../background/circuit-breaker.js'
import { isAllowedUrl, NetworkPolicyError, type NetworkPolicy } from './allowlist.js'

export interface NetworkAuditEntry {
  at: number
  url: string
  ok: boolean
  status?: number
  error?: string
}

export interface NetworkClientOptions {
  policy?: NetworkPolicy
  timeoutMs?: number
  /** Breaker guarding commons/validator egress. */
  breaker?: CircuitBreaker
  /** Max requests per minute (default 60; 0 = unlimited). */
  maxRequestsPerMinute?: number
  now?: () => number
}

export interface EvolveNetworkClient {
  /** Fetch text with policy enforcement (throws NetworkPolicyError on policy
   * violations and CircuitOpenError when the breaker is open). */
  fetchText(url: string): Promise<string>
  /** Append-only audit of every request. */
  auditLog(): readonly NetworkAuditEntry[]
}

const DEFAULT_TIMEOUT_MS = 10_000

export class DefaultEvolveNetworkClient implements EvolveNetworkClient {
  private readonly policy: NetworkPolicy
  private readonly timeoutMs: number
  private readonly breaker: CircuitBreaker
  private readonly maxPerMinute: number
  private readonly now: () => number
  private readonly audit: NetworkAuditEntry[] = []
  private requestTimes: number[] = []

  constructor(options: NetworkClientOptions = {}) {
    this.policy = options.policy ?? { allowedHosts: ['raw.githubusercontent.com', 'github.com', 'api.github.com', 'objects.githubusercontent.com', 'codeload.github.com'] }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.breaker = options.breaker ?? new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30 * 60 * 1000 })
    this.maxPerMinute = options.maxRequestsPerMinute ?? 60
    this.now = options.now ?? Date.now
  }

  auditLog(): readonly NetworkAuditEntry[] {
    return [...this.audit]
  }

  private rateLimited(): boolean {
    if (this.maxPerMinute <= 0) return false
    const now = this.now()
    const windowStart = now - 60_000
    this.requestTimes = this.requestTimes.filter(time => time > windowStart)
    if (this.requestTimes.length >= this.maxPerMinute) return true
    this.requestTimes.push(now)
    return false
  }

  async fetchText(url: string): Promise<string> {
    // 1. Allowlist.
    const verdict = isAllowedUrl(url, this.policy)
    if (!verdict.allowed) {
      const error = new NetworkPolicyError(verdict.reason)
      this.audit.push({ at: this.now(), url, ok: false, error: error.message })
      throw error
    }
    // 2. Rate limit.
    if (this.rateLimited()) {
      const error = new Error('dsh-evolve: rate limit exceeded (network client)')
      this.audit.push({ at: this.now(), url, ok: false, error: error.message })
      throw error
    }
    // 3. Circuit breaker.
    if (!this.breaker.allow()) {
      const error = new Error('dsh-evolve: circuit open (network client)')
      this.audit.push({ at: this.now(), url, ok: false, error: error.message })
      throw error
    }
    // 4. Fetch with timeout.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
      const status = response.status
      if (!response.ok) {
        this.breaker.recordFailure()
        const error = new Error(`HTTP ${status}`)
        this.audit.push({ at: this.now(), url, ok: false, status, error: error.message })
        throw error
      }
      const text = await response.text()
      this.breaker.recordSuccess()
      this.audit.push({ at: this.now(), url, ok: true, status })
      return text
    } catch (error) {
      if ((error as Error).name !== 'AbortError') this.breaker.recordFailure()
      const message = (error as Error).name === 'AbortError' ? 'timeout' : (error as Error).message
      this.audit.push({ at: this.now(), url, ok: false, error: message })
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
