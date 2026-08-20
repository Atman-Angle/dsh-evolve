/**
 * Audit report + orchestrator (v0.2 release hardening, spec §二十二, §二十三).
 *
 * Runs the checks for a scope and writes `reports/audit/latest.md`.
 *
 * @module dsh-evolve/audit/report
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuditCheck, AuditReport, AuditScope } from './contracts.js'
import { auditPrivilege } from './privilege.js'
import { auditFilesystem } from './filesystem.js'
import { auditNetwork } from './network.js'
import { auditLifecycle } from './lifecycle.js'
import { auditNonInterference } from './non-interference.js'
import { auditFailureIsolation } from './failure-isolation.js'
import { auditPrivacy } from './privacy.js'
import { auditSupplyChain } from './supply-chain.js'
import { auditSkillSecurity } from './skill-security.js'
import { runOverheadBenchmark, writeOverheadReport } from '../offline/benchmark.js'
import { resolveDshHome } from '../storage/evolve-store.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)

function packageVersion(): string {
  try {
    const raw = require('node:fs').readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8') as string
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The checks that belong to each scope. */
export async function runScopeChecks(scope: AuditScope, opts: { root: string; repoRoot: string; lifecycleIterations: number }): Promise<AuditCheck[]> {
  const checks: AuditCheck[] = []
  const add = async (check: Promise<AuditCheck> | AuditCheck): Promise<void> => {
    checks.push(await check)
  }
  if (scope === 'security' || scope === 'all') {
    await add(auditPrivilege(opts.repoRoot))
    await add(auditFilesystem(opts.repoRoot))
    await add(auditNetwork(opts.repoRoot))
    await add(auditSupplyChain())
    await add(auditSkillSecurity())
  }
  if (scope === 'privacy' || scope === 'all') {
    await add(auditPrivacy())
  }
  if (scope === 'runtime' || scope === 'all') {
    await add(auditNonInterference())
    await add(auditFailureIsolation())
    await add(runOverheadCheck(opts.root))
  }
  if (scope === 'lifecycle' || scope === 'all') {
    await add(auditLifecycle(opts.lifecycleIterations))
  }
  return checks
}

/** Overhead check: run a reduced benchmark and write the report. */
async function runOverheadCheck(root: string): Promise<AuditCheck> {
  const result = runOverheadBenchmark([1_000, 10_000])
  await writeOverheadReport(result, root)
  return {
    id: 'runtime-overhead',
    name: 'Runtime overhead (per-event bounded)',
    scope: 'runtime',
    verdict: result.pass ? 'PASS' : 'FAIL',
    detail: result.detail,
    evidence: result.samples,
  }
}

/** Detect the DSH version from the harness if reachable, else undefined. */
export async function detectDshVersion(): Promise<string | undefined> {
  try {
    const modules = await readdir(join(PACKAGE_ROOT, 'node_modules', '@deepseek-ai'))
    const session = modules.find(name => name.startsWith('dsh-session'))
    if (session === undefined) return undefined
    const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'node_modules', '@deepseek-ai', session, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

/** Run the full audit for a scope and persist reports/audit/latest.md. */
export async function runAudit(
  scope: AuditScope = 'all',
  opts: { root?: string; repoRoot?: string; lifecycleIterations?: number } = {},
): Promise<AuditReport> {
  const root = opts.root ?? join(resolveDshHome(), 'evolve')
  const repoRoot = opts.repoRoot ?? PACKAGE_ROOT
  const lifecycleIterations = opts.lifecycleIterations ?? 30
  const checks = await runScopeChecks(scope, { root, repoRoot, lifecycleIterations })
  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    pluginVersion: packageVersion(),
    ...(await detectDshVersion().then(version => version === undefined ? {} : { dshVersion: version })),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    checks,
    pass: checks.every(check => check.verdict === 'PASS'),
  }
  await writeAuditReport(report, root)
  return report
}

/** Render the report as markdown. */
export function renderAuditReport(report: AuditReport): string {
  const lines = [
    '# dsh-evolve Release Audit',
    '',
    `generated: ${report.generatedAt}`,
    `plugin: ${report.pluginVersion} dsh: ${report.dshVersion ?? 'unknown'} node: ${report.nodeVersion} platform: ${report.platform}`,
    '',
    '| check | verdict | detail |',
    '|---|---|---|',
    ...report.checks.map(check => `| ${check.name} | ${check.verdict} | ${check.detail} |`),
    '',
    `**Release Audit: ${report.pass ? 'PASS' : 'FAIL'}**`,
    '',
  ]
  return lines.join('\n')
}

/** Persist the audit report to reports/audit/latest.md. */
export async function writeAuditReport(report: AuditReport, root: string): Promise<string> {
  const path = join(root, 'reports', 'audit', 'latest.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${renderAuditReport(report)}\n`, 'utf8')
  return path
}
