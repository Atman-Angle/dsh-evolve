/**
 * Experience contracts (v0.2).
 *
 * An Experience is a distilled regularity mined from one or more real sessions
 * that MAY be useful for future tasks. Experiences never modify the system
 * directly — they must pass through the Mutation framework with Evidence.
 *
 * Data tiers: L0 raw session (local only) → L1 private experience (local only)
 * → L2 shareable capsule (after the Privacy Compiler) → L3 community prior.
 *
 * @module dsh-evolve/experience/contracts
 */

/** The five base experience kinds (spec §6). */
export type ExperienceKind =
  | 'fact'
  | 'preference'
  | 'correction'
  | 'successful-procedure'
  | 'failure-pattern'

/** Promotion state machine shared by every evolvable object (spec §11). */
export type ExperienceStatus =
  | 'DISCOVERED'
  | 'CANDIDATE'
  | 'VALIDATING'
  | 'ACTIVE'
  | 'DEPRECATED'
  | 'REJECTED'

/** Quantified support behind an experience/mutation (spec §3.3). */
export interface EvidenceSummary {
  /** Distinct sessions that contributed evidence. */
  sessions: number
  /** Total occurrences across sessions. */
  occurrences: number
  /** Occurrences where the pattern ended successfully. */
  successfulOccurrences: number
  /** Occurrences where the pattern ended in failure. */
  failedOccurrences: number
  /** Aggregate confidence in [0, 1]. */
  confidence: number
}

/** Compatibility envelope: an experience is never treated as timeless truth. */
export interface Compatibility {
  harness?: {
    name: string
    minVersion?: string
  }
  task?: {
    domain?: string
    language?: string
    framework?: string
  }
  environment?: {
    language?: string
    packageManager?: string
  }
}

/** Traceability for every experience / mutation (spec §24). */
export interface Provenance {
  origin: {
    local: boolean
    /** Set when the experience derives from a downloaded community capsule. */
    commonsId?: string
    capsuleHash?: string
    gitCommit?: string
    release?: string
  }
  derivedFrom?: {
    experienceIds?: string[]
    mutationId?: string
    evalId?: string
  }
  /** Monotonic version of the experience's payload (immutable history). */
  version: number
}

/** One canonicalized tool step inside a procedure/correction. */
export interface ActionStep {
  /** Tool name, e.g. `bash`, `write`, `read`. */
  tool: string
  /** Canonical action key (fingerprint of tool + deep-sorted args). */
  actionKey: string
  /** Truncated canonical arguments — readability only, never raw secrets. */
  args: string
}

export interface FactPayload {
  /** Subject, e.g. `package-manager`. */
  subject: string
  /** Property, e.g. `name`. */
  property: string
  /** Value, e.g. `pnpm`. */
  value: string
  /** How broadly the fact is claimed to hold. */
  scope: 'project' | 'workspace' | 'environment'
}

export interface PreferencePayload {
  /** What the user prefers, e.g. `pnpm over npm`. */
  preference: string
  /** The disfavored alternative, when known. */
  over?: string
  /** Optional domain, e.g. `coding:typescript`. */
  domain?: string
  /** Where the preference was observed. */
  scope: string
}

/** The core correction form: A → failure/correction → B → success (spec §6.3). */
export interface CorrectionPayload {
  /** Short, normalized context of the failed step. */
  context: string
  /** The failed approach (A). */
  failed: ActionStep
  /** The corrected approach that succeeded (B). */
  succeeded: ActionStep
  /** Error-signature keys observed on the failed approach. */
  failureKeys: string[]
}

/** A procedure that repeatedly preceded success (spec §6.4). */
export interface ProcedurePayload {
  /** Short context summary (truncated; raw task text never stored). */
  context: string
  /** Ordered canonical steps, in execution order. */
  steps: ActionStep[]
}

/** A repeated no-progress pattern (spec §6.5). */
export interface FailurePatternPayload {
  /** Canonical signature (error-signature key or action key). */
  signature: string
  kind: 'repeated-error' | 'repeated-action' | 'no-progress'
  /** Measured repeat count. */
  repeats: number
  /** Human-readable normalized description. */
  description: string
  /** Suggested schema-defined action enum, when applicable. */
  recommendedAction?: string
}

export type ExperiencePayload =
  | FactPayload
  | PreferencePayload
  | CorrectionPayload
  | ProcedurePayload
  | FailurePatternPayload

/** A persisted experience record (L1, local-only by default). */
export interface ExperienceRecord {
  id: string
  kind: ExperienceKind
  status: ExperienceStatus
  /** One-line normalized summary. */
  summary: string
  /** Stable dedup key — fingerprint over the payload's identity fields. */
  summaryKey: string
  createdAt: string
  updatedAt: string
  /** Sessions that contributed evidence. */
  sessionIds: string[]
  evidence: EvidenceSummary
  compatibility: Compatibility
  provenance: Provenance
  payload: ExperiencePayload
}

/** The outcome a miner attributes to a candidate (drives evidence counts). */
export type CandidateOutcome = 'success' | 'failure' | 'neutral'

/** A freshly mined, not-yet-persisted experience (before dedup/aggregation). */
export interface CandidateExperience {
  kind: ExperienceKind
  summary: string
  summaryKey: string
  sessionId: string
  outcome: CandidateOutcome
  compatibility: Compatibility
  payload: ExperiencePayload
}
