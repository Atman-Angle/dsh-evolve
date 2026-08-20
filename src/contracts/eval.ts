/**
 * Eval contracts: task definitions, graders, run results, and the
 * baseline-vs-treatment comparison that feeds reports/latest.md.
 *
 * @module dsh-evolve/contracts/eval
 */

/** One long-horizon coding task: immutable fixture + prompt + grader. */
export interface TaskDefinition {
  id: string
  /** Human-readable task title. */
  title?: string
  /** Path to the immutable workspace fixture (tarball/zip or a directory). */
  fixture: string
  /** Path to the task prompt file (the only model-facing task text). */
  prompt: string
  /** Per-run budget constraints (identical across arms). */
  constraints?: {
    maxSteps?: number
    maxTokensOutput?: number
  }
  grader: GraderConfig
}

/** Deterministic grader: commands (exit 0) plus filesystem assertions. */
export interface GraderConfig {
  /** Commands run with cwd = the finished workspace; all must exit 0. */
  commands?: string[]
  /** Filesystem assertions applied after commands pass. */
  assertions?: FsAssertion[]
  /** Optional numeric score extractor: a command whose stdout parses to a number. */
  scoreCommand?: string
}

export interface FsAssertion {
  /** Path relative to the workspace. */
  path: string
  /** File must exist. */
  exists?: boolean
  /** File content must contain this substring. */
  contains?: string
}

/** One finished run of one task under one arm. */
export interface EvalRunResult {
  taskId: string
  runId: string
  /** Arm/policy id (e.g. `baseline` | `reset-v1`). */
  policyId: string
  /** True only when the external deterministic grader passed. */
  success: boolean
  steps: number
  toolCalls: number
  inputTokens?: number
  outputTokens?: number
  durationMs: number
  stuckEvents: number
  interventions: number
  /** Injections followed by success or visible progress (treatment arm). */
  recovered?: number
  /** Injections with neither recovery nor success (treatment arm). */
  falsePositives?: number
  finalScore?: number
}

/** Aggregated metrics over a set of runs (one arm). */
export interface Metrics {
  runs: number
  successRate: number
  avgSteps: number
  avgToolCalls: number
  avgInputTokens?: number
  avgOutputTokens?: number
  avgDurationMs: number
  stuckRate: number
  totalInterventions: number
  /** Runs that were stuck at least once. */
  stuckRuns: number
}

/** Baseline vs treatment comparison for the report. */
export interface Comparison {
  baseline: Metrics
  treatment: Metrics
  /** Paired-by-task deltas; null when pairing is impossible. */
  successDeltaPp?: number
  avgStepsDelta?: number
  avgInputTokensDelta?: number
  avgDurationMsDelta?: number
  stuckRateDeltaPp?: number
  /** Injections observed in the treatment arm. */
  treatmentInterventions: number
  /** Injections followed by success or visible recovery (computed by the runner). */
  recovered: number
  /** Injections with neither recovery nor eventual success. */
  falsePositives: number
}

/** A single reportable case for the "cases" section. */
export interface CaseNote {
  kind: 'success' | 'failure' | 'false-positive' | 'regression'
  taskId: string
  runId: string
  note: string
}

/** Everything reports/latest.md renders. */
export interface ReportData {
  dataset: { tasks: number }
  model?: string
  runs: { baseline: number; treatment: number }
  comparison: Comparison
  cases: CaseNote[]
  generatedAt: string
}