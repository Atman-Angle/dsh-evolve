import { describe, expect, it } from 'vitest'
import { retrieveExperiences, renderTemporaryContext } from '../src/experience/retriever.js'
import type { ExperienceRecord } from '../src/experience/contracts.js'

function record(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: 'exp-1', kind: 'correction', status: 'ACTIVE', summary: 'Use pnpm for TypeScript installs', summaryKey: 'k',
    createdAt: '2025-01-01', updatedAt: '2025-01-01', sessionIds: ['s1', 's2'],
    evidence: { sessions: 2, occurrences: 3, successfulOccurrences: 3, failedOccurrences: 0, confidence: 0.8 },
    compatibility: {}, provenance: { origin: { local: true }, version: 1 },
    payload: { context: 'typescript', failed: { tool: 'npm', actionKey: 'a', args: '{}' }, succeeded: { tool: 'pnpm', actionKey: 'b', args: '{}' }, failureKeys: [] },
    ...overrides,
  }
}

describe('experience retrieval', () => {
  it('returns at most three relevant, sufficiently supported experiences', () => {
    const records = [record(), ...Array.from({ length: 5 }, (_, index) => record({ id: `exp-${index + 2}`, summary: `pnpm workflow ${index}` }))]
    const matches = retrieveExperiences(records, { text: 'TypeScript pnpm install' })
    expect(matches).toHaveLength(3)
    expect(matches[0]?.relevance).toBeGreaterThan(0)
  })

  it('filters incompatible, weak, and rejected records', () => {
    const matches = retrieveExperiences([
      record({ compatibility: { task: { language: 'python' } } }),
      record({ id: 'weak', evidence: { sessions: 1, occurrences: 1, successfulOccurrences: 1, failedOccurrences: 0, confidence: 0.1 } }),
      record({ id: 'rejected', status: 'REJECTED' }),
    ], { text: 'TypeScript pnpm install', language: 'typescript' })
    expect(matches).toHaveLength(0)
  })

  it('renders a bounded temporary context block', () => {
    const output = renderTemporaryContext(retrieveExperiences([record()], { text: 'pnpm' }), 100)
    expect(output.length).toBeLessThanOrEqual(100)
    expect(output).toContain('pnpm')
  })
})
