/**
 * Automatic Commons sync (v0.2, spec §21, §22).
 *
 * Background sync: check manifest → compare release → download → verify →
 * update the local community cache. The local registry only ever moves
 * AVAILABLE → DOWNLOADED automatically; nothing becomes ACTIVE without local
 * evidence. Sync is fully offline-safe: every fetch goes through an injectable
 * fetcher (tests use a fake; the CLI uses global fetch with a timeout).
 *
 * @module dsh-evolve/commons/sync
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { JsonlStore } from '../storage/jsonl-store.js'
import { DefaultEvolveNetworkClient, type EvolveNetworkClient } from '../network/client.js'
import { isNewerRelease, parseManifest, type CommonsManifest } from './manifest.js'
import { sha256, verifyCapsule } from './verifier.js'

export type SyncInterval = 'startup' | 'daily' | '6h' | 'manual' | 'disabled'

export type RegistryStatus = 'AVAILABLE' | 'DOWNLOADED' | 'SHADOW' | 'ACTIVE' | 'REJECTED'

export interface RegistryRecord {
  id: string
  status: RegistryStatus
  hash: string
  release: string
  path: string
  downloadedAt?: string
}

export interface SyncState {
  lastSyncAt?: string
  currentRelease?: string
}

export type Fetcher = (url: string) => Promise<string>

const INTERVAL_MS: Record<Exclude<SyncInterval, 'startup' | 'manual' | 'disabled'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
}

/** Pure interval decision. `startup` syncs when never synced (or always on
 * process start — callers pass force accordingly). */
export function shouldSync(
  interval: SyncInterval,
  state: { lastSyncAt?: string; currentRelease?: string },
  now = Date.now(),
  force = false,
): boolean {
  if (force) return true
  if (interval === 'disabled') return false
  if (interval === 'manual') return false
  if (interval === 'startup') return state.lastSyncAt === undefined || state.currentRelease === undefined
  const last = state.lastSyncAt === undefined ? 0 : Date.parse(state.lastSyncAt)
  return Number.isFinite(last) && now - last >= INTERVAL_MS[interval]
}

/** Join a manifest URL with a relative entry path. */
export function assetUrl(manifestUrl: string, path: string): string {
  return manifestUrl.replace(/\/[^/]*$/, `/${path}`)
}

export interface SyncResult {
  checked: boolean
  updated: boolean
  currentRelease?: string
  downloaded: string[]
  failed: Array<{ id: string; reason: string }>
}

export interface SyncOptions {
  force?: boolean
  interval?: SyncInterval
  now?: number
}

export class SyncEngine {
  private readonly cacheDir: string
  private readonly registry: JsonlStore<RegistryRecord>
  private readonly statePath: string
  private readonly fetcher: Fetcher

  /**
   * @param root - evolve store root.
   * @param fetcher - injectable fetcher (tests). Defaults to the unified
   *   network client so ALL egress goes through the allowlist/breaker/audit.
   */
  constructor(root: string, fetcher?: Fetcher, client?: EvolveNetworkClient) {
    this.cacheDir = join(root, 'commons', 'cache')
    this.registry = new JsonlStore(root, 'commons/registry.jsonl')
    this.statePath = join(root, 'commons', 'state.json')
    const resolvedClient = client ?? new DefaultEvolveNetworkClient()
    this.fetcher = fetcher ?? resolvedClient.fetchText.bind(resolvedClient)
  }

  private async readState(): Promise<SyncState> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as SyncState
    } catch {
      return {}
    }
  }

  private async writeState(state: SyncState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true })
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /**
   * Run one sync pass.
   * @param manifestUrl - URL of `registry/index.json` on the Commons.
   */
  async sync(manifestUrl: string, options: SyncOptions = {}): Promise<SyncResult> {
    const interval = options.interval ?? '6h'
    const state = await this.readState()
    if (!shouldSync(interval, state, options.now ?? Date.now(), options.force)) {
      return { checked: false, updated: false, downloaded: [], failed: [] }
    }

    let raw: string
    try {
      raw = await this.fetcher(manifestUrl)
    } catch (error) {
      return { checked: true, updated: false, downloaded: [], failed: [{ id: 'manifest', reason: (error as Error).message }] }
    }
    const parsed = parseManifest(JSON.parse(raw))
    if (!parsed.ok || parsed.manifest === undefined) {
      return { checked: true, updated: false, downloaded: [], failed: [{ id: 'manifest', reason: parsed.errors.join('; ') }] }
    }
    const manifest: CommonsManifest = parsed.manifest
    const newer = isNewerRelease(manifest.release, state.currentRelease)
    if (!newer && !(options.force ?? false)) {
      return {
        checked: true,
        updated: false,
        ...(state.currentRelease === undefined ? {} : { currentRelease: state.currentRelease }),
        downloaded: [],
        failed: [],
      }
    }

    const downloaded: string[] = []
    const failed: Array<{ id: string; reason: string }> = []
    const existing = await this.registry.read()
    const byId = new Map(existing.map(record => [record.id, record]))

    for (const entry of manifest.entries) {
      const current = byId.get(entry.id)
      if (current !== undefined && current.hash === entry.hash && current.status === 'DOWNLOADED') continue
      try {
        const content = await this.fetcher(assetUrl(manifestUrl, entry.path))
        if (sha256(content) !== entry.hash) {
          throw new Error('hash mismatch')
        }
        const capsule = JSON.parse(content) as unknown
        const verified = verifyCapsule(capsule)
        if (verified.status !== 'ok') {
          throw new Error(`verify failed: ${verified.detail}`)
        }
        await mkdir(this.cacheDir, { recursive: true })
        await writeFile(join(this.cacheDir, `${entry.id}.json`), content, 'utf8')
        byId.set(entry.id, {
          id: entry.id,
          status: 'DOWNLOADED', // automatic sync NEVER goes further (spec §22)
          hash: entry.hash,
          release: manifest.release,
          path: entry.path,
          downloadedAt: new Date().toISOString(),
        })
        downloaded.push(entry.id)
      } catch (error) {
        failed.push({ id: entry.id, reason: (error as Error).message })
      }
    }

    await this.registry.replaceAll([...byId.values()])
    await this.writeState({ lastSyncAt: new Date().toISOString(), currentRelease: manifest.release })
    return {
      checked: true,
      updated: downloaded.length > 0,
      currentRelease: manifest.release,
      downloaded,
      failed,
    }
  }

  /** Local registry view (statuses per spec §22). */
  async registryView(): Promise<RegistryRecord[]> {
    return (await this.registry.read()).sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Read a cached capsule body. */
  async readCached(id: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.cacheDir, `${id}.json`), 'utf8')
    } catch {
      return undefined
    }
  }
}
