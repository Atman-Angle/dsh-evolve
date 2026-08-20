/**
 * Canonicalization of tool invocations: `(tool name, canonical arguments)`
 * must compare equal when only JSON key order or payload order differs, so
 * "the exact same call" is detected deterministically. Mirrors the proven
 * approach of the official `dsh-repeat-tool-reminder` plugin.
 *
 * @module dsh-evolve/features/invocation-normalizer
 */

import { fingerprint } from './hash.js'

/**
 * Deep key-sort a parsed JSON value so argument objects that differ only in
 * property order canonicalize identically. Arguments reach the collector as
 * raw JSON text from `tool/call`; malformed JSON stays raw text.
 */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/**
 * Parse raw model arguments; invalid JSON is preserved as the raw string
 * (the model's malformed payload is itself part of the call identity).
 */
export function parseArguments(raw: string): unknown {
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Canonical string form of a call's arguments (deep key-sort, then stringify). */
export function canonicalArguments(raw: string): string {
  return JSON.stringify(sortJsonValue(parseArguments(raw)))
}

/**
 * Canonical action key of one invocation: hash of `(name, canonical args)`.
 * @param name - tool name.
 * @param rawArguments - the model's raw arguments JSON string.
 * @returns stable action key.
 */
export function actionKey(name: string, rawArguments: string): string {
  return fingerprint(`${name}\u0000${canonicalArguments(rawArguments)}`)
}