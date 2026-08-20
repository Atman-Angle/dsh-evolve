import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolveStore, resolveDshHome, resolveEvolveRoot } from '../src/storage/evolve-store.js'
import type { InterventionRecord, RunSummary } from '../src/contracts/intervention.js'

describe('resolveEvolveRoot / resolveDshHome', () => {
  it('honors DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: 'C:/harness' } as NodeJS.ProcessEnv)).toBe('C:/harness')
  })

  it('falls back to ~/.dsh without DSH_HOME', () => {
    const root = resolveDshHome({})
    expect(root.endsWith('.dsh')).toBe(true)
  })

  it('appends /evolve', () => {
    expect(resolveEvolveRoot({ home: 'C:/harness' })).toBe(join('C:/harness', 'evolve'))
  })

  it('prefers an explicit root', () => {
    expect(resolveEvolveRoot({ root: 'D:/x' })).toBe('D:/x')
  })
})

describe('EvolveStore', () => {
  async function makeStore(): Promise<{ store: EvolveStore; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-store-'))
    return { store: new EvolveStore(dir), dir }
  }

  it('appends intervention records as JSONL', async () => {
    const { store, dir } = await makeStore()
    const record: InterventionRecord = {
      sessionId: 's1', turn: 1, step: 5, score: 0.8, reasons: [{ signal: 'repeated-actions', count: 3 }],
      policyId: 'reset-v1', policyVersion: '1.0.0', injected: true, seam: 'step-end', timestamp: 1,
    }
    const other = { ...record, step: 6, reasons: [] }
    await store.appendIntervention(record)
    await store.appendIntervention(other)
    const content = await readFile(join(dir, 'runs', 's1.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ sessionId: 's1', step: 5 })
  })

  it('writes and replaces a run summary atomically', async () => {
    const { store, dir } = await makeStore()
    const summary: RunSummary = {
      sessionId: 's2', policyId: 'baseline', policyVersion: '1.0.0',
      steps: 4, toolCalls: 5, inputTokens: 100, outputTokens: 20,
      durationMs: 1000, stuckEvents: 1, interventions: 1, injections: 0, ended: 'completed',
    }
    await store.writeRunSummary(summary)
    await store.writeRunSummary({ ...summary, steps: 9 })
    const content = JSON.parse(await readFile(join(dir, 'runs', 's2.summary.json'), 'utf8')) as RunSummary
    expect(content.steps).toBe(9)
  })

  it('readActiveRecipeId returns undefined when no active.json exists', async () => {
    const { store } = await makeStore()
    expect(await store.readActiveRecipeId()).toBeUndefined()
  })

  it('sanitizes hostile session ids', async () => {
    const { store } = await makeStore()
    await store.appendIntervention({
      sessionId: '../../evil', turn: 1, step: 1, score: 0, reasons: [],
      policyId: 'p', policyVersion: '1', injected: false, seam: 'record-only', timestamp: 0,
    })
    const content = await readFile(join(store.layout.runsDir, '.._.._evil.jsonl'), 'utf8')
    expect(content).toContain('"sessionId":"../../evil"')
  })
})