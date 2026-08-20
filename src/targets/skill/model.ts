/**
 * Skill model (v0.2, Targets 3/4 — Skill Creation & Optimization, risk 3).
 *
 * Skills are versioned, evidence-backed, and rollback-safe. Local candidate
 * skills follow  Proposal → Review → Activate; community skills follow the
 * download-quarantine-scan-test-approve chain (spec §17).
 *
 * @module dsh-evolve/targets/skill/model
 */

import type { EvidenceSummary } from '../../experience/contracts.js'

/** Skill security status chain (spec §17, §28 Phase 7). */
export type SkillStatus =
  | 'AVAILABLE' // listed in a community registry
  | 'DOWNLOADED' // fetched, not trusted
  | 'QUARANTINED' // isolated from the agent
  | 'STATIC_SCAN'
  | 'SEMANTIC_REVIEW'
  | 'LOCAL_TEST'
  | 'CANDIDATE' // local generated candidate awaiting approval
  | 'ACTIVE' // usable by the agent
  | 'REJECTED'
  | 'DEPRECATED'

export type SkillSource = 'local' | 'generated' | 'community'

/** What makes the skill match a task at runtime (routing input). */
export interface SkillTrigger {
  /** Canonical action keys the skill is known to cover. */
  actionKeys?: string[]
  /** Tool names involved. */
  tools?: string[]
  /** Free keywords matched against task context (lowercased). */
  keywords?: string[]
}

/** One immutable version of a skill. */
export interface SkillVersion {
  version: number
  description: string
  instructions: string[]
  trigger: SkillTrigger
  createdAt: string
  /** What evidence + mutation created this version. */
  createdFrom: {
    experienceIds: string[]
    mutationId?: string
  }
  evidence: EvidenceSummary
}

export interface SkillUsage {
  activations: number
  successes: number
  failures: number
  lastUsedAt?: string
}

export interface Skill {
  id: string
  name: string
  status: SkillStatus
  source: SkillSource
  /** Current (active) version number. */
  currentVersion: number
  /** Immutable version history — never overwritten in place. */
  versions: SkillVersion[]
  usage: SkillUsage
  provenance: {
    origin: {
      local: boolean
      commonsId?: string
      capsuleHash?: string
    }
  }
  /** Rollback target: the previous version number, if any. */
  rollbackToVersion?: number
  createdAt: string
  updatedAt: string
}

/** A fresh skill drafted from an experience (before it becomes a version). */
export interface SkillDraft {
  name: string
  description: string
  trigger: SkillTrigger
  instructions: string[]
}

/** Minimal skill view for routing/planner decisions. */
export interface SkillSummary {
  id: string
  name: string
  version: number
  status: SkillStatus
  trigger: SkillTrigger
}

/** Legal skill-status transitions (community chain + local chain). */
const LEGAL: Record<SkillStatus, readonly SkillStatus[]> = {
  AVAILABLE: ['DOWNLOADED', 'REJECTED'],
  DOWNLOADED: ['QUARANTINED', 'REJECTED'],
  QUARANTINED: ['STATIC_SCAN', 'REJECTED'],
  STATIC_SCAN: ['SEMANTIC_REVIEW', 'REJECTED', 'QUARANTINED'],
  SEMANTIC_REVIEW: ['LOCAL_TEST', 'REJECTED', 'QUARANTINED'],
  LOCAL_TEST: ['CANDIDATE', 'REJECTED', 'QUARANTINED'],
  CANDIDATE: ['ACTIVE', 'REJECTED'],
  ACTIVE: ['DEPRECATED', 'CANDIDATE'],
  DEPRECATED: ['REJECTED'],
  REJECTED: [],
}

export function legalSkillTransition(from: SkillStatus, to: SkillStatus): boolean {
  return LEGAL[from].includes(to)
}

/** Whether the agent may read this skill (spec §17: only active/ is readable). */
export function isAgentVisible(status: SkillStatus): boolean {
  return status === 'ACTIVE'
}
