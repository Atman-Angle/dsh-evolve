/**
 * Capability policy (v0.2, spec §17, §18).
 *
 * Downloaded/community skills start with ZERO capabilities (default deny).
 * Capabilities are granted only after the full
 * QUARANTINED → STATIC_SCAN → SEMANTIC_REVIEW → LOCAL_TEST → CANDIDATE chain
 * plus explicit approval. Even then, the harness (sandbox, tool policy,
 * approval) remains the enforcement authority — this policy is a declaration,
 * not a bypass.
 *
 * @module dsh-evolve/security/capability-policy
 */

import type { SkillStatus } from '../targets/skill/model.js'

export type Capability = 'tools' | 'network' | 'files' | 'context'

/** Capability scope granted at each skill status (spec §17 chain). */
const CAPABILITIES_BY_STATUS: Record<SkillStatus, readonly Capability[]> = {
  AVAILABLE: [],
  DOWNLOADED: [],
  QUARANTINED: [],
  STATIC_SCAN: [],
  SEMANTIC_REVIEW: [],
  LOCAL_TEST: ['tools'], // test-only tool access
  CANDIDATE: ['tools'],
  ACTIVE: ['tools', 'files', 'context'], // full normal agent scope
  REJECTED: [],
  DEPRECATED: [],
}

/** Capabilities a skill may exercise at its current status. */
export function capabilitiesFor(status: SkillStatus): readonly Capability[] {
  return CAPABILITIES_BY_STATUS[status]
}

/** Whether a capability is allowed for a skill at its current status. */
export function allowsCapability(status: SkillStatus, capability: Capability): boolean {
  return CAPABILITIES_BY_STATUS[status].includes(capability)
}

/** The default-deny verdict for a downloaded skill. */
export function downloadedSkillPolicy(): { capabilities: readonly Capability[]; readable: boolean } {
  return { capabilities: [], readable: false }
}

/** Agent-visible skills (spec §17: only active/). */
export function isReadableByAgent(status: SkillStatus): boolean {
  return status === 'ACTIVE'
}

/** Whether network capability is granted (never for downloaded skills). */
export function networkAllowed(status: SkillStatus): boolean {
  return false // remote content never earns network capability in v0.2
}
