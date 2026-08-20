/**
 * Failure isolation audit test (spec §十四).
 *
 * Injected failures (miner crash, store failure, GitHub 500/timeout/429,
 * corrupt state, …) must never disturb the agent task: evolve fails →
 * capability paused + diagnostic → vanilla DSH continues.
 */

import { describe, expect, it } from 'vitest'
import { auditFailureIsolation } from '../../src/audit/failure-isolation.js'

describe('failure isolation audit', () => {
  it('the agent task completes under every injected evolve failure', async () => {
    const check = await auditFailureIsolation()
    expect(check.verdict).toBe('PASS')
    const evidence = check.evidence as Array<{ name: string; pass: boolean; detail: string }>
    expect(evidence).toHaveLength(7) // miner/privacy/semantic/store/github/invalid/corrupt
    for (const scenario of evidence) {
      expect(scenario.pass, `${scenario.name}: ${scenario.detail}`).toBe(true)
    }
  })
})
