/**
 * Offline session-log reader: locates and decodes DSH's JSONL session
 * artifacts (`session.jsonl` / `session.jsonl.zstd`) outside a running DSH.
 *
 * Path encoding mirrors the official `dsh-session-persistence-jsonl`
 * `encodeSegment` (same algorithm, attribution in the header comment); event
 * rows are decoded with the official `decodeStorageRecord` so packed
 * `assistant/chunk` runs and plain events both come back as canonical
 * `SessionEvent`s.
 *
 * @module dsh-evolve/offline/session-reader
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** Packed `assistant/chunk` run rows (DSH storage vocabulary, slash-less tags). */
const PACKED_CHUNK_ROWS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/**
 * Tolerantly decode one storage line into a session event. Packed chunk rows
 * are skipped: they reconstruct `assistant/chunk` events, which the detector
 * never consumes. Any other well-formed event line passes through verbatim.
 * This keeps the offline reader free of runtime `@deepseek-ai/*` imports.
 */
function decodeRecord(record: unknown): SessionEvent | null {
  if (typeof record !== 'object' || record === null) {
    throw new Error('corrupt session log: record is not an object')
  }
  const candidate = record as Record<string, unknown>
  if (typeof candidate.type !== 'string') throw new Error('corrupt session log: record has no type')
  if (PACKED_CHUNK_ROWS.has(candidate.type)) return null
  if (typeof candidate.seq !== 'number' || typeof candidate.time !== 'number') {
    throw new Error(`corrupt session log: record ${JSON.stringify(candidate.type)} lacks seq/time`)
  }
  return record as SessionEvent
}

/**
 * Encode an arbitrary session id as one safe path segment, injectively over
 * all JS strings. Algorithm mirrors the DSH jsonl backend's `encodeSegment`
 * (MIT — DeepSeek Harness, `packages/session/session-persistence-jsonl`).
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/** Zstandard frame magic (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

export interface SessionLog {
  header: SessionHeader
  events: SessionEvent[]
  /** Absolute path of the artifact that was read. */
  source: string
}

/** Decompress a zstd artifact (possibly concatenated frames, checksummed). */
export function decompressZstd(buffer: Buffer): Buffer {
  const lib = zstdDecompressSync as ((input: Buffer) => Buffer) | undefined
  if (typeof lib !== 'function') {
    throw new Error('session reader: node:zlib zstd support is unavailable (Node >= 23.3 required) — configure the session backend with compression: none instead')
  }
  try {
    return lib(buffer) // libzstd handles concatenated frames natively
  } catch {
    // Fallback: split at frame magics and decode each frame independently.
    const parts: Buffer[] = []
    let cursor = 0
    for (let i = 1; i < buffer.length - ZSTD_MAGIC.length; i++) {
      if (buffer.subarray(i, i + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
        parts.push(lib(buffer.subarray(cursor, i)))
        cursor = i
      }
    }
    parts.push(lib(buffer.subarray(cursor)))
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    return Buffer.concat(parts, total)
  }
}

/** Parse a raw JSONL session artifact into header + events. */
export function parseSessionLog(buffer: Buffer, source: string): SessionLog {
  const text = buffer.toString('utf8')
  const lines = text.split('\n')
  if (lines.length === 0 || lines[0] === '') throw new Error(`${source}: empty or header-less session log`)
  let header: SessionHeader | undefined
  const events: SessionEvent[] = []
  let first = true
  for (const line of lines) {
    if (line === '') continue
    const record = JSON.parse(line) as { type?: unknown }
    if (first) {
      first = false
      if (record.type !== 'session') throw new Error(`${source}: first line is not a session header`)
      const raw = JSON.parse(line) as SessionHeader & { type: string }
      header = { ...raw } as SessionHeader
      continue
    }
    const decoded = decodeRecord(record)
    if (decoded !== null) events.push(decoded)
  }
  if (header === undefined) throw new Error(`${source}: missing session header`)
  return { header, events, source }
}

/** Read one session artifact (raw or zstd) into header + events. */
export async function readSessionFile(path: string): Promise<SessionLog> {
  const buffer = await readFile(path)
  const decoded = path.endsWith('.zstd') ? decompressZstd(buffer) : buffer
  return parseSessionLog(decoded, path)
}

/**
 * Locate a session's artifact under a root, scanning project directories
 * (`<root>/<project>/<encoded-id>/session.jsonl[.zstd]`), mirroring the backend layout.
 * @param root - session root (e.g. `~/.dsh/sessions`).
 * @param id - session id.
 * @returns matched artifact path or undefined.
 */
export async function findSessionArtifact(root: string, id: string): Promise<string | undefined> {
  const encoded = encodeSegment(id)
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates: string[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const suffix of ['.jsonl.zstd', '.jsonl'] as const) {
      const path = join(root, project.name, encoded, `session${suffix}`)
      try {
        await readFile(path)
        candidates.push(path)
      } catch {
        // absent — continue scanning
      }
    }
  }
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new Error(`session reader: multiple artifacts found for ${id}: ${candidates.join(', ')}`)
  }
  return undefined
}

/** List every session artifact under a root (`<root>/<project>/<session>/session.jsonl[.zstd]`). */
export async function listSessionArtifacts(root: string): Promise<string[]> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const sessions = await readdir(join(root, project.name), { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      for (const suffix of ['.jsonl.zstd', '.jsonl'] as const) {
        const path = join(root, project.name, session.name, `session${suffix}`)
        try {
          await readFile(path)
          paths.push(path)
          break
        } catch {
          // absent — try the other suffix
        }
      }
    }
  }
  return paths
}