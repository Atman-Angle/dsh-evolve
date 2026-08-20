/**
 * Non-interference audit test (spec §十一).
 *
 * A == B == C: vanilla DSH, DSH + observation, DSH + full background evolution
 * must produce identical trajectories. If the observer changes any model/tool
 * trajectory → Audit Fail.
 */

import { describe, expect, it } from 'vitest'
import { runNonInterference, trajectoryMetrics, fixtureEvents } from '../../src/audit/non-interference.js'

describe('non-interference audit', () => {
  it('derives trajectory metrics from the durable log (ground truth)', () => {
    const metrics = trajectoryMetrics(fixtureEvents())
    expect(metrics.toolCalls).toBe(2)
    expect(metrics.toolNames).toEqual(['bash', 'bash'])
    expect(metrics.toolArguments[0]).toContain('npm install')
    expect(metrics.steps).toBe(2)
    expect(metrics.completed).toBe(true)
    expect(metrics.turns).toEqual([1, 2])
  })

  it('A == B == C: the observer never changes the trajectory', async () => {
    const result = await runNonInterference()
    expect(result.pass).toBe(true)
    const { A, B, C } = result.arms
    expect(JSON.stringify(B)).toBe(JSON.stringify(A))
    expect(JSON.stringify(C)).toBe(JSON.stringify(A))
  })
})
