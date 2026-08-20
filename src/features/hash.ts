/**
 * Zero-dependency deterministic fingerprints for v0.1 stuck signals.
 * All functions are pure and stable across processes — the same input always
 * yields the same key, which is what makes runtime detections replayable.
 *
 * @module dsh-evolve/features/hash
 */

import { createHash } from 'node:crypto'

/**
 * Stable 128-bit (hex) fingerprint of a text string, using truncated SHA-256.
 * @param text - input text.
 * @returns 32 hex chars; empty input hashes to the hash of the empty string.
 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

/** Whitespace-collapse normalization for observation/error text. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Strip ANSI escape sequences (tool output often carries them). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * Normalize model-facing text for fingerprinting: strip ANSI, collapse
 * whitespace, and cap the length so a pathological result cannot blow up the
 * hot path. The cap applies to the fingerprint input only — the raw event
 * stays untouched in the DSH log.
 * @param text - raw text.
 * @param cap - maximum normalized length (default 8000 chars).
 * @returns normalized text.
 */
export function normalizeText(text: string, cap = 8000): string {
  const normalized = collapseWhitespace(stripAnsi(text))
  return normalized.length <= cap ? normalized : normalized.slice(0, cap)
}

/** Fingerprint of normalized text: {@link normalizeText} + {@link fingerprint}. */
export function textFingerprint(text: string, cap = 8000): string {
  return fingerprint(normalizeText(text, cap))
}