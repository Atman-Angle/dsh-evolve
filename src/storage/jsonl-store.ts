/**
 * Generic atomic JSONL store (v0.2).
 *
 * Shared persistence base for the v0.2 stores (experiences, mutations, memory,
 * profile, routing, capsules, …). Same guarantees as the v0.1 EvolveStore:
 * - atomic writes (temp file + rename, with retry);
 * - all mutations serialized through an internal queue;
 * - reads tolerant of torn tail lines.
 *
 * The v0.1 EvolveStore is intentionally left untouched.
 *
 * @module dsh-evolve/storage/jsonl-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export interface JsonlRecord {
  id: string
}

/** Windows can transiently refuse a rename over a just-removed path; retry. */
async function replaceFile(temp: string, target: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rm(target, { force: true })
      await rename(temp, target)
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
  throw lastError
}

/** Serialize one record to a JSON line (stable key order via JSON.stringify). */
export function jsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

/** Validate a store id before it flows into a file name (no traversal). */
export function assertSafeStoreId(id: string, label = 'store id'): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw new Error(`dsh-evolve: unsafe ${label} ${JSON.stringify(id)}`)
  }
}

export class JsonlStore<T extends JsonlRecord> {
  private readonly file: string
  /** Serializes all file mutations so read-modify-write appends never interleave. */
  private queue: Promise<void> = Promise.resolve()
  private tempCounter = 0

  constructor(
    private readonly root: string,
    relativePath: string,
  ) {
    // Path-traversal guard: relative paths come from code constants, never
    // from user input; a '..' segment would escape the evolve store root.
    if (relativePath.split(/[\\/]/).includes('..')) {
      throw new Error(`dsh-evolve: unsafe store relative path ${JSON.stringify(relativePath)}`)
    }
    this.file = join(root, relativePath)
  }

  /** Ensure the store file's directory exists (idempotent). */
  async ensure(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
  }

  private locked<V>(operation: () => Promise<V>): Promise<V> {
    const run = this.queue.then(operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Unique temp suffix per instance+call so concurrent stores never collide. */
  private tempName(target: string): string {
    this.tempCounter += 1
    return `${target}.${process.pid}.${randomUUID().slice(0, 8)}.${this.tempCounter}.tmp`
  }

  /** Read all records (tolerant of torn tail lines). */
  async read(): Promise<T[]> {
    let content = ''
    try {
      content = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return []
      throw error
    }
    const records: T[] = []
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as T
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string') {
          records.push(parsed)
        }
      } catch {
        // torn tail line — tolerated (serialized queue makes it rare)
      }
    }
    return records
  }

  /** Replace the whole file content (atomic). */
  async replaceAll(records: readonly T[]): Promise<void> {
    return this.locked(async () => {
      await this.ensure()
      const body = records.map(jsonLine).join('')
      const temp = this.tempName(this.file)
      await writeFile(temp, body, 'utf8')
      await replaceFile(temp, this.file)
    })
  }

  /** Append one record (atomic read-modify-write via temp file). */
  async append(record: T): Promise<void> {
    return this.locked(async () => {
      await this.ensure()
      const temp = this.tempName(this.file)
      let existing = ''
      try {
        existing = await readFile(this.file, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT') throw error
      }
      await writeFile(temp, existing + jsonLine(record), 'utf8')
      await replaceFile(temp, this.file)
    })
  }

  /** Read-modify-write one record by id; returns the new record or undefined. */
  async update(id: string, mutate: (record: T) => T): Promise<T | undefined> {
    return this.locked(async () => {
      const records = await this.read()
      let updated: T | undefined
      const next = records.map(record => {
        if (record.id !== id) return record
        updated = mutate(record)
        return updated
      })
      if (updated === undefined) return undefined
      await this.replaceAllUnlocked(next)
      return updated
    })
  }

  private async replaceAllUnlocked(records: readonly T[]): Promise<void> {
    await this.ensure()
    const body = records.map(jsonLine).join('')
    const temp = this.tempName(this.file)
    await writeFile(temp, body, 'utf8')
    await replaceFile(temp, this.file)
  }

  /** Absolute path of the store file (for tests and reports). */
  get path(): string {
    return this.file
  }
}
