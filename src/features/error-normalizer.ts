/**
 * Error-signature normalization: `(tool, error code, normalized error text)`
 * collapses the same failure repeated with phrasing noise into one stable key,
 * making "MODULE_NOT_FOUND x3" stronger evidence than "3 tool failures".
 *
 * @module dsh-evolve/features/error-normalizer
 */

import type { ErrorSignature } from '../contracts/trajectory.js'
import { fingerprint, normalizeText } from './hash.js'

/** Baselines for the text part of a signature when a piece is absent. */
const ABSENT = '<absent>'

/**
 * Structural key of an error signature. Order is fixed so two equal signatures
 * always hash identically regardless of which optional fields were supplied.
 * @param signature - normalized error facts.
 * @returns stable error-signature key.
 */
export function errorSignatureKey(signature: ErrorSignature): string {
  const tool = signature.tool ?? ABSENT
  const code = signature.code ?? signature.name ?? ABSENT
  const text = normalizeText(signature.text) || code
  return fingerprint(`${tool}\u0000${code}\u0000${text}`)
}