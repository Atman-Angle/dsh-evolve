import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { encodeSegment, parseSessionLog, readSessionFile } from '../src/offline/session-reader.js'

function headerLine(id: string): string {
  return JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0 })
}

function buildJsonl(id: string): string {
  return [
    headerLine(id),
    JSON.stringify({ type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'tool/call', seq: 1, time: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{}' } }),
    JSON.stringify({ type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } }),
  ].join('\n')
}

describe('encodeSegment', () => {
  it('keeps safe ids literal', () => {
    expect(encodeSegment('abc-123._-')).toBe('abc-123._-')
  })

  it('escapes traversal attempts', () => {
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('../evil')).toContain('~002F')
  })
})

describe('parseSessionLog', () => {
  it('parses header and event lines', () => {
    const log = parseSessionLog(Buffer.from(buildJsonl('s1')), 'memory')
    expect(log.header.id).toBe('s1')
    expect(log.events).toHaveLength(3)
    expect(log.events[0]?.type).toBe('step/start')
    expect(log.events[2]?.type).toBe('step/end')
  })

  it('rejects a missing header', () => {
    expect(() => parseSessionLog(Buffer.from('{"type":"step/start"}\n'), 'memory')).toThrow(/header/)
  })
})

describe('readSessionFile (zstd + raw)', () => {
  it('round-trips through zstd frames', async () => {
    const compress = zstdCompressSync as ((input: Buffer) => Buffer) | undefined
    if (typeof compress !== 'function') return // node without zstd support
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-reader-'))
    const text = buildJsonl('s2')
    const path = join(dir, 'session.jsonl.zstd')
    await writeFile(path, compress(Buffer.from(text)))
    const log = await readSessionFile(path)
    expect(log.source.endsWith('.zstd')).toBe(true)
    expect(log.header.id).toBe('s2')
    expect(log.events).toHaveLength(3)
  })

  it('reads plain jsonl raw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-reader-'))
    const path = join(dir, 'session.jsonl')
    await writeFile(path, buildJsonl('s3'), 'utf8')
    const log = await readSessionFile(path)
    expect(log.events).toHaveLength(3)
  })
})