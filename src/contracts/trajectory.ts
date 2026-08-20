/**
 * Normalized trajectory vocabulary shared by the runtime collector and the
 * offline analyzer. DSH session events are adapted to this vocabulary at the
 * boundary; everything downstream is pure and DSH-agnostic.
 *
 * @module dsh-evolve/contracts/trajectory
 */

/** A tool failure signature: what the model repeated, structurally. */
export interface ErrorSignature {
  /** Tool name (from `tool/call`), when known. */
  tool?: string
  /** Structured error name, e.g. `ToolTimeoutError`. */
  name?: string
  /** Structured error code, e.g. `TOOL_TIMEOUT`. */
  code?: string
  /** Normalized error text (whitespace-collapsed, capped). */
  text: string
}

/** One observed tool call, before canonicalization. */
export interface ToolCallObserved {
  name: string
  /** Raw model arguments JSON string (unparsed). */
  arguments: string
  turn: number
  step: number
}

/** One observed tool result. */
export interface ToolResultObserved {
  isError: boolean
  /** Parsed error signature for failures; absent on success. */
  error?: ErrorSignature
  /** Concatenated text content of the result (capped) — fingerprint input. */
  contentText: string
  turn: number
  step: number
}

/** Normalized events the feature extractor consumes, in log order. */
export type CollectorEvent =
  | { type: 'step/start'; turn: number; step: number }
  | { type: 'step/end'; turn: number; step: number }
  | {
    type: 'user/message'
    /** source.kind from the DSH message source. */
    sourceKind: string
    /** Task text when available (used by routing; never required). */
    text?: string
  }
  | { type: 'tool/call'; data: ToolCallObserved }
  | { type: 'tool/result'; data: ToolResultObserved }
  | { type: 'turn/end'; reasonKind: string }

/** One step's condensed outcome used for window bookkeeping. */
export interface StepOutcome {
  turn: number
  step: number
  /** Number of failed tool results in this step. */
  failures: number
  /** Whether a mutation-class tool call succeeded in this step. */
  mutationOk: boolean
  /** Canonical action keys of this step's calls, in call order. */
  actionKeys: string[]
  /** Canonical error-signature keys of this step's failed results. */
  errorKeys: string[]
  /** Observation fingerprints of this step's results (success and error). */
  observationKeys: string[]
  /** How many of this step's observation fingerprints were novel. */
  novelCount: number
}