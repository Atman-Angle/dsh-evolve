/**
 * Circuit breaker (v0.2 release hardening, spec §四).
 *
 * Guards every background external dependency (semantic miner, GitHub Commons,
 * filesystem store, optional validator). On repeated failures (429 / quota /
 * timeout / provider_unavailable) the breaker OPENS: the corresponding
 * capability pauses, retries stop, and normal DSH keeps running. After a
 * cooldown it allows a limited probe (HALF_OPEN) before recovering.
 *
 * Fail-open invariant: a breaker that is open only disables EVOLVE work —
 * it never touches the agent path.
 *
 * @module dsh-evolve/background/circuit-breaker
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface BreakerOptions {
  /** Consecutive failures that trip the breaker (default 3). */
  failureThreshold: number
  /** Milliseconds the breaker stays OPEN (default 30 min). */
  cooldownMs: number
  /** Max probe calls allowed while HALF_OPEN (default 1). */
  halfOpenMax?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export const DEFAULT_BREAKER_OPTIONS: Required<BreakerOptions> = {
  failureThreshold: 3,
  cooldownMs: 30 * 60 * 1000,
  halfOpenMax: 1,
  now: Date.now,
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED'
  private failures = 0
  private openedAt = 0
  private halfOpenProbes = 0
  private readonly opts: Required<BreakerOptions>

  constructor(options: Partial<BreakerOptions> = {}) {
    this.opts = { ...DEFAULT_BREAKER_OPTIONS, ...options }
  }

  get status(): { state: BreakerState; failures: number; openedAt: number } {
    return { state: this.state, failures: this.failures, openedAt: this.openedAt }
  }

  /** Whether a call may proceed now (mutates HALF_OPEN probe counters). */
  allow(): boolean {
    const now = this.opts.now()
    if (this.state === 'CLOSED') return true
    if (this.state === 'OPEN') {
      if (now - this.openedAt >= this.opts.cooldownMs) {
        this.state = 'HALF_OPEN'
        this.halfOpenProbes = 0
        return this.takeProbe()
      }
      return false
    }
    // HALF_OPEN: allow a bounded number of probes.
    return this.takeProbe()
  }

  private takeProbe(): boolean {
    if (this.halfOpenProbes < this.opts.halfOpenMax) {
      this.halfOpenProbes += 1
      return true
    }
    return false
  }

  recordSuccess(): void {
    this.failures = 0
    if (this.state === 'HALF_OPEN' || this.state === 'OPEN') {
      this.state = 'CLOSED'
    }
    this.halfOpenProbes = 0
    this.openedAt = 0
  }

  recordFailure(): void {
    this.failures += 1
    if (this.state === 'HALF_OPEN') {
      this.trip()
      return
    }
    if (this.failures >= this.opts.failureThreshold) {
      this.trip()
    }
  }

  private trip(): void {
    this.state = 'OPEN'
    this.openedAt = this.opts.now()
    this.halfOpenProbes = 0
  }

  /** Force-reset (maintenance / manual evolve run). */
  reset(): void {
    this.state = 'CLOSED'
    this.failures = 0
    this.openedAt = 0
    this.halfOpenProbes = 0
  }
}

/** Named breaker capability ids (spec §四). */
export type BreakerCapability = 'semantic-miner' | 'commons' | 'store' | 'validator' | 'privacy'

export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>()
  private readonly options: Partial<BreakerOptions>

  constructor(options: Partial<BreakerOptions> = {}) {
    this.options = options
  }

  get(capability: string): CircuitBreaker {
    let breaker = this.breakers.get(capability)
    if (breaker === undefined) {
      breaker = new CircuitBreaker(this.options)
      this.breakers.set(capability, breaker)
    }
    return breaker
  }

  /** Health snapshot for status/audit output. */
  snapshot(): Record<string, { state: BreakerState; failures: number }> {
    const out: Record<string, { state: BreakerState; failures: number }> = {}
    for (const [name, breaker] of this.breakers) {
      const status = breaker.status
      out[name] = { state: status.state, failures: status.failures }
    }
    return out
  }
}

/** Classify a failure as "breaker-worthy" (429/quota/timeout/unavailable/5xx). */
export function isRetryableFailure(error: unknown): boolean {
  const message = (error as Error | null)?.message ?? String(error)
  const lower = message.toLowerCase()
  return /429|quota|rate[ _-]?limit|timeout|timed out|unavailable|5\d\d|econnreset|econnrefused|etimedout|circuit open/i.test(lower)
}

/** Error thrown when a breaker is open. */
export class CircuitOpenError extends Error {
  constructor(readonly capability: string) {
    super(`dsh-evolve: circuit open for ${capability} — evolution capability paused`)
    this.name = 'CircuitOpenError'
  }
}
