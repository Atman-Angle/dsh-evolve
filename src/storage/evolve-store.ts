/**
 * dsh-evolve's own persisted store, kept OUT of the DSH durable session log.
 *
 * Layout (default):
 *   <DSH_HOME|~/.dsh>/evolve/
 *     policies/            active recipe + versioned recipes
 *     runs/                <sessionId>.jsonl  (intervention records)
 *                          <sessionId>.summary.json (RunSummary)
 *     evals/  reports/     reserved for the Offline Lab
 *
 * All writes are atomic (temp file + rename). The store is best-effort from
 * the runtime's perspective: an observer failure must never break a DSH run,
 * so callers wrap store-IO failures at the boundary.
 *
 * @module dsh-evolve/storage/evolve-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { InterventionRecord, RunSummary } from '../contracts/intervention.js'

/** Resolve the harness home: $DSH_HOME, else the platform user home + `.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME
  if (explicit !== undefined && explicit !== '') return explicit
  return join(homedir(), '.dsh')
}

/** Resolve the dsh-evolve store root. */
export function resolveEvolveRoot(options: { root?: string; home?: string } = {}): string {
  if (options.root !== undefined && options.root !== '') return options.root
  return join(options.home ?? resolveDshHome(), 'evolve')
}

/** A minimal deterministic JSON writer used by the store (stable key order). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

interface StorePaths {
  runsDir: string
  policiesDir: string
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

export class EvolveStore {
  private readonly paths: StorePaths
  /** Serializes all file mutations so read-modify-write appends never interleave. */
  private queue: Promise<void> = Promise.resolve()
  private tempCounter = 0

  constructor(root: string) {
    this.paths = {
      runsDir: join(root, 'runs'),
      policiesDir: join(root, 'policies'),
    }
  }

  /** Ensure the store directories exist (idempotent). */
  async ensure(): Promise<void> {
    await mkdir(this.paths.runsDir, { recursive: true })
    await mkdir(this.paths.policiesDir, { recursive: true })
  }

  private runsFilePath(sessionId: string): string {
    return join(this.paths.runsDir, `${this.safeName(sessionId)}.jsonl`)
  }

  private summaryPath(sessionId: string): string {
    return join(this.paths.runsDir, `${this.safeName(sessionId)}.summary.json`)
  }

  /** Session ids are branded arbitrary strings — sanitize before path use. */
  private safeName(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
    return safe === '' ? 'session' : safe
  }

  /** Run one file mutation exclusively, keeping the queue alive on failure. */
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Append one intervention record as a JSON line (atomic, serialized). */
  appendIntervention(record: InterventionRecord): Promise<void> {
    return this.locked(async () => {
      await this.ensure()
      const line = `${stableJson(record)}\n`
      const path = this.runsFilePath(record.sessionId)
      // Atomic append: read-modify-write via temp file keeps the artifact valid
      // even if a previous write was torn; a unique temp name removes collision.
      const temp = `${path}.${process.pid}.${(this.tempCounter += 1)}.tmp`
      let existing = ''
      try {
        existing = await readFile(path, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT') throw error
      }
      await writeFile(temp, existing + line, 'utf8')
      await replaceFile(temp, path)
    })
  }

  /** Write a run summary (atomic replace, serialized). */
  writeRunSummary(summary: RunSummary): Promise<void> {
    return this.locked(async () => {
      await this.ensure()
      const path = this.summaryPath(summary.sessionId)
      const temp = `${path}.${process.pid}.${(this.tempCounter += 1)}.tmp`
      await writeFile(temp, `${stableJson(summary)}\n`, 'utf8')
      await replaceFile(temp, path)
    })
  }

  /** Read the intervention records persisted for one session (tolerant). */
  async readInterventions(sessionId: string): Promise<InterventionRecord[]> {
    const path = this.runsFilePath(sessionId)
    let content = ''
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return []
      throw error
    }
    const records: InterventionRecord[] = []
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line) as InterventionRecord)
      } catch {
        // a torn tail line is tolerated; the serialized queue makes it rare
      }
    }
    return records
  }

  /** Read the active recipe id, if a policies/active.json exists. */
  async readActiveRecipeId(): Promise<string | undefined> {
    try {
      const content = await readFile(join(this.paths.policiesDir, 'active.json'), 'utf8')
      const parsed = JSON.parse(content) as { id?: unknown }
      return typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : undefined
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return undefined
      throw error
    }
  }

  /** The on-disk paths (for tests and reports). */
  get layout(): StorePaths {
    return this.paths
  }
}