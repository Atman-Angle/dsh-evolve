/**
 * Audit report integration test (spec §二十二, §二十三).
 *
 * `runAudit('all')` runs every check and writes reports/audit/latest.md with
 * plugin/node/platform info and PASS/FAIL.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAudit, renderAuditReport } from '../../src/audit/report.js'

describe('audit report', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

  it('runAudit(all) passes and writes latest.md with metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-report-'))
    dirs.push(root)
    const report = await runAudit('all', { root, lifecycleIterations: 15 })
    expect(report.pass).toBe(true)
    expect(report.checks.length).toBeGreaterThanOrEqual(9)
    expect(report.pluginVersion).toBeDefined()
    expect(report.nodeVersion).toContain('v')
    expect(report.platform).toBeDefined()
    const ids = report.checks.map(check => check.id)
    for (const id of ['privilege', 'filesystem', 'network', 'commons-supply-chain', 'skill-security', 'privacy-adversarial', 'non-interference', 'failure-isolation', 'runtime-overhead', 'lifecycle']) {
      expect(ids).toContain(id)
    }
    const md = await readFile(join(root, 'reports', 'audit', 'latest.md'), 'utf8')
    expect(md).toContain('Release Audit: PASS')
    expect(renderAuditReport(report)).toContain('| check | verdict | detail |')
  })
})
