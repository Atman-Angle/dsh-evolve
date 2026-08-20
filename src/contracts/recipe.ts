/**
 * Policy Recipe — the versioned contract between the Offline Lab and the
 * Runtime Plugin. The runtime executes exactly the currently active recipe and
 * never modifies one online.
 *
 * @module dsh-evolve/contracts/recipe
 */

/** Thresholds/weights for the five deterministic signals. */
export interface SignalConfig {
  /** Run length that saturates this signal's normalized score (the "expected" stuck length). */
  threshold: number
  /** Contribution to {@link StuckScore} when the signal is saturated. */
  weight: number
}

/** Repeated-action-specific tuning: identical calls are only evidence when no state changed. */
export interface RepeatedActionsConfig extends SignalConfig {
  /**
   * Discount applied to the repeated-action contribution when the window shows
   * no novel observation and no workspace change (0 = no discount, 1 = full
   * discount). Protects "edit -> test -> edit -> test" cycles from misreading.
   */
  noveltyDiscount: number
}

/** Workspace-change signal (E). Off by default in v0.1 until proven reliable. */
export interface WorkspaceChangeConfig extends SignalConfig {
  enabled: boolean
}

/** Fully parameterized detector. */
export interface DetectorConfig {
  /** Sliding window of steps/tool calls over which runs are measured. */
  windowSize: number
  consecutiveFailures: SignalConfig
  repeatedActions: RepeatedActionsConfig
  repeatedErrors: SignalConfig
  noNovelObservation: SignalConfig
  workspaceChange: WorkspaceChangeConfig
  /** Normalized stuck score at or above which the detector fires. */
  triggerScore: number
  /**
   * Tool-name patterns (exact or `*` wildcard) treated as workspace mutations
   * for signal E. Empty means a built-in default list is used.
   */
  mutationTools?: string[]
}

/** The single v0.1 intervention type. */
export type InterventionType = 'strategy-reset'

/** Intervention limits (anti-runaway). After the caps: keep detecting, stop injecting. */
export interface InterventionConfig {
  type: InterventionType
  /** Master switch — false makes the observer record-only (baseline arm). */
  enabled: boolean
  /** Minimum steps between two injections. */
  cooldownSteps: number
  /** Maximum injections per turn. */
  maxPerTurn: number
  /** Maximum injections per session. */
  maxPerSession: number
  /** Optional override of the default STRATEGY_RESET message text. */
  messageTemplate?: string
}

/** Versioned runtime policy. */
export interface PolicyRecipe {
  id: string
  version: string
  detector: DetectorConfig
  intervention: InterventionConfig
  metadata?: {
    createdAt?: string
    sourceExperiment?: string
    compatibleDshVersion?: string
  }
}