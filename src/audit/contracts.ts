/**
 * Audit contracts (v0.2 release hardening, spec §八-§十七, §二十二).
 *
 * A release audit is a list of named checks with PASS/FAIL/WARN verdicts and
 * evidence. `dsh-evolve audit --all` runs every scope and writes
 * `reports/audit/latest.md`.
 *
 * @module dsh-evolve/audit/contracts
 */

export type AuditScope = 'security' | 'privacy' | 'runtime' | 'lifecycle' | 'all'
export type AuditVerdict = 'PASS' | 'FAIL' | 'WARN'

export interface AuditCheck {
  id: string
  name: string
  scope: Exclude<AuditScope, 'all'>
  verdict: AuditVerdict
  detail: string
  /** Structured evidence (counts, findings, measurements). */
  evidence?: unknown
}

export interface AuditReport {
  generatedAt: string
  pluginVersion: string
  dshVersion?: string
  nodeVersion: string
  platform: string
  checks: AuditCheck[]
  pass: boolean
}

export interface AuditContext {
  /** Evolve store root (default `~/.dsh/evolve`). */
  root: string
  /** Repo root for source scans (default: this package). */
  repoRoot: string
  /** Lifecycle iterations for the lifecycle audit (default 30). */
  lifecycleIterations?: number
}
