/**
 * Commons manifest (v0.2, spec §21, §15).
 *
 * The Commons is a plain GitHub repository (`github.com/dsh-evolve/commons`);
 * its `registry/index.json` is the manifest clients sync from. This module
 * parses/validates the manifest shape and compares releases.
 *
 * @module dsh-evolve/commons/manifest
 */

import type { CapsuleKind } from '../privacy/capsule.js'

export interface ManifestEntry {
  id: string
  kind: CapsuleKind | 'skill'
  /** Content hash of the entry file (sha256 hex, 64 chars). */
  hash: string
  /** Relative path inside the release asset. */
  path: string
  supportBucket?: string
  outcomeDirection?: string
}

export interface CommonsManifest {
  schema: 'evolve-commons/manifest'
  /** Manifest schema version (not the capsule schema). */
  version: string
  /** Capsule schema version all entries must satisfy. */
  schemaVersion: 'evolve/v1'
  release: string
  publishedAt: string
  entries: ManifestEntry[]
}

export interface ManifestParseResult {
  ok: boolean
  manifest?: CommonsManifest
  errors: string[]
}

/** Parse + validate a manifest document (fail loud on structural issues). */
export function parseManifest(json: unknown): ManifestParseResult {
  const errors: string[] = []
  if (json === null || typeof json !== 'object') {
    return { ok: false, errors: ['manifest must be an object'] }
  }
  const manifest = json as Partial<CommonsManifest>
  if (manifest.schema !== 'evolve-commons/manifest') errors.push('schema must be evolve-commons/manifest')
  if (typeof manifest.version !== 'string' || manifest.version === '') errors.push('version is required')
  if (manifest.schemaVersion !== 'evolve/v1') errors.push('schemaVersion must be evolve/v1')
  if (typeof manifest.release !== 'string') errors.push('release is required')
  if (typeof manifest.publishedAt !== 'string') errors.push('publishedAt is required')
  if (!Array.isArray(manifest.entries)) {
    errors.push('entries must be an array')
    return { ok: errors.length === 0, errors }
  }
  for (const entry of manifest.entries) {
    if (entry === null || typeof entry !== 'object') {
      errors.push('entries must be objects')
      continue
    }
    if (typeof entry.id !== 'string' || entry.id === '') errors.push('entry.id required')
    if (typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash)) {
      errors.push(`entry ${String(entry.id)} hash must be 64-hex`)
    }
    if (typeof entry.path !== 'string' || entry.path === '') errors.push(`entry ${String(entry.id)} path required`)
  }
  return {
    ok: errors.length === 0,
    ...(errors.length === 0 ? { manifest: manifest as CommonsManifest } : {}),
    errors,
  }
}

/** Find an entry by id. */
export function findEntry(manifest: CommonsManifest, id: string): ManifestEntry | undefined {
  return manifest.entries.find(entry => entry.id === id)
}

/** Compare two release/version strings ("2025-01-15" or "1.2.3"). */
export function compareReleases(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value.split(/[.-]/).map(part => Number.parseInt(part, 10)).map(part => Number.isFinite(part) ? part : 0)
  const aParts = parse(a)
  const bParts = parse(b)
  const length = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** Whether release `candidate` is newer than `current`. */
export function isNewerRelease(candidate: string, current: string | undefined): boolean {
  if (current === undefined || current === '') return true
  return compareReleases(candidate, current) > 0
}
