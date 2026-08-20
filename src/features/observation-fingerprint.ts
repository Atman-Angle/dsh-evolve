/**
 * Observation fingerprints: a low-cost hash of tool-result content so the
 * detector can tell "same observation again" from "new information" without
 * any embedding or model call.
 *
 * @module dsh-evolve/features/observation-fingerprint
 */

import { textFingerprint } from './hash.js'

/**
 * Fingerprint one tool result's text content for novelty comparison.
 * Content is normalized (ANSI-stripped, whitespace-collapsed) and capped.
 * @param contentText - concatenated result text.
 * @param cap - normalized length cap (default 8000).
 * @returns stable fingerprint.
 */
export function observationFingerprint(contentText: string, cap = 8000): string {
  return textFingerprint(contentText, cap)
}