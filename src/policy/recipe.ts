/**
 * Policy Recipe validation and built-in default recipes. The runtime executes
 * exactly the validated active recipe; malformed recipes fail loud at load
 * (never silent fallback beyond the documented baseline default).
 *
 * @module dsh-evolve/policy/recipe
 */

import type { DetectorConfig, PolicyRecipe, SignalConfig } from '../contracts/recipe.js'

const TOTAL_WEIGHT_TOLERANCE = 1e-6

/** Validate one signal sub-config and return it typed. */
function signalConfig(raw: unknown, name: string): SignalConfig {
  if (typeof raw !== 'object' || raw === null) throw invalid(name, 'must be an object')
  const record = raw as Record<string, unknown>
  if (typeof record.threshold !== 'number' || !Number.isFinite(record.threshold) || record.threshold < 1) {
    throw invalid(name, 'threshold must be a finite number >= 1')
  }
  if (typeof record.weight !== 'number' || !Number.isFinite(record.weight) || record.weight < 0) {
    throw invalid(name, 'weight must be a finite number >= 0')
  }
  return { threshold: record.threshold, weight: record.weight }
}

function invalid(field: string, message: string): Error {
  return new Error(`dsh-evolve recipe: invalid detector.${field} — ${message}`)
}

/** Validate a detector config; throws with a precise message on failure. */
export function validateDetectorConfig(raw: unknown): asserts raw is DetectorConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('dsh-evolve recipe: detector must be an object')
  const record = raw as Record<string, unknown>
  const windowSize = record.windowSize
  if (!Number.isInteger(windowSize) || (windowSize as number) < 1) {
    throw invalid('windowSize', 'must be a positive integer')
  }
  const consecutiveFailures = signalConfig(record.consecutiveFailures, 'consecutiveFailures')
  const repeatedActions = signalConfig(record.repeatedActions, 'repeatedActions')
  const repeatedActionsRaw = record.repeatedActions as Record<string, unknown>
  if (typeof repeatedActionsRaw.noveltyDiscount !== 'number'
    || (repeatedActionsRaw.noveltyDiscount as number) < 0
    || (repeatedActionsRaw.noveltyDiscount as number) > 1) {
    throw invalid('repeatedActions.noveltyDiscount', 'must be a number in [0, 1]')
  }
  const repeatedErrors = signalConfig(record.repeatedErrors, 'repeatedErrors')
  const noNovelObservation = signalConfig(record.noNovelObservation, 'noNovelObservation')
  const workspaceChange = signalConfig(record.workspaceChange, 'workspaceChange')
  const workspaceChangeRaw = record.workspaceChange as Record<string, unknown>
  if (typeof workspaceChangeRaw.enabled !== 'boolean') {
    throw invalid('workspaceChange.enabled', 'must be a boolean')
  }
  const triggerScore = record.triggerScore
  if (typeof triggerScore !== 'number' || !Number.isFinite(triggerScore) || (triggerScore as number) < 0 || (triggerScore as number) > 1) {
    throw invalid('triggerScore', 'must be a number in [0, 1]')
  }
  const weightsSum = consecutiveFailures.weight
    + repeatedActions.weight
    + repeatedErrors.weight
    + noNovelObservation.weight
    // A disabled signal contributes nothing; only enabled signals must balance.
    + (workspaceChangeRaw.enabled === true ? workspaceChange.weight : 0)
  if (Math.abs(weightsSum - 1) > TOTAL_WEIGHT_TOLERANCE && weightsSum > 0) {
    throw new Error(`dsh-evolve recipe: detector weights of enabled signals must sum to 1 (got ${weightsSum})`)
  }
}

/** Normalize a parsed recipe object into a validated {@link PolicyRecipe}. */
export function parseRecipe(value: unknown): PolicyRecipe {
  if (typeof value !== 'object' || value === null) throw new Error('dsh-evolve recipe: must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) throw new Error('dsh-evolve recipe: id must be a non-empty string')
  if (typeof record.version !== 'string' || record.version.length === 0) throw new Error('dsh-evolve recipe: version must be a non-empty string')
  validateDetectorConfig(record.detector)
  const intervention = record.intervention as Record<string, unknown> | undefined
  if (typeof intervention !== 'object' || intervention === null) throw new Error('dsh-evolve recipe: intervention must be an object')
  if (intervention.type !== 'strategy-reset') throw new Error(`dsh-evolve recipe: unsupported intervention type ${JSON.stringify(intervention.type)}`)
  if (typeof intervention.enabled !== 'boolean') throw new Error('dsh-evolve recipe: intervention.enabled must be a boolean')
  for (const key of ['cooldownSteps', 'maxPerTurn', 'maxPerSession'] as const) {
    const value = intervention[key]
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`dsh-evolve recipe: intervention.${key} must be a non-negative integer`)
    }
  }
  if (intervention.messageTemplate !== undefined && typeof intervention.messageTemplate !== 'string') {
    throw new Error('dsh-evolve recipe: intervention.messageTemplate must be a string')
  }
  const metadata = record.metadata
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null)) {
    throw new Error('dsh-evolve recipe: metadata must be an object')
  }
  return value as PolicyRecipe
}

/** The default STRATEGY_RESET message (domain-agnostic, template per spec §八). */
export const DEFAULT_RESET_TEMPLATE = [
  'The current execution trajectory appears to be producing little new progress.',
  '',
  'Do not continue the same approach automatically.',
  '',
  'Before taking the next action:',
  '1. summarize only the concrete facts established so far,',
  '2. identify the assumption or strategy that has failed,',
  '3. explicitly abandon that approach,',
  '4. choose a materially different next strategy,',
  '5. continue execution.',
  '',
  'Do not repeat previous tool calls unless the environment or relevant state has changed.',
].join('\n')

/** Built-in baseline recipe: observer-on, injection-off (control arm). */
export const BASELINE_RECIPE: PolicyRecipe = {
  id: 'baseline',
  version: '1.0.0',
  detector: {
    windowSize: 6,
    consecutiveFailures: { threshold: 3, weight: 0.35 },
    repeatedActions: { threshold: 3, weight: 0.25, noveltyDiscount: 0.5 },
    repeatedErrors: { threshold: 2, weight: 0.25 },
    noNovelObservation: { threshold: 4, weight: 0.15 },
    workspaceChange: { enabled: false, threshold: 5, weight: 0.15 },
    triggerScore: 0.65,
  },
  intervention: { type: 'strategy-reset', enabled: false, cooldownSteps: 5, maxPerTurn: 1, maxPerSession: 3 },
  metadata: { sourceExperiment: 'baseline-control' },
}

/** Built-in first candidate: strategy reset enabled. */
export const RESET_V1_RECIPE: PolicyRecipe = {
  id: 'reset-v1',
  version: '1.0.0',
  detector: {
    windowSize: 6,
    consecutiveFailures: { threshold: 3, weight: 0.35 },
    repeatedActions: { threshold: 3, weight: 0.25, noveltyDiscount: 0.5 },
    repeatedErrors: { threshold: 2, weight: 0.25 },
    noNovelObservation: { threshold: 4, weight: 0.15 },
    workspaceChange: { enabled: false, threshold: 5, weight: 0.15 },
    triggerScore: 0.65,
  },
  intervention: {
    type: 'strategy-reset', enabled: true,
    cooldownSteps: 5, maxPerTurn: 1, maxPerSession: 3,
    messageTemplate: DEFAULT_RESET_TEMPLATE,
  },
  metadata: { sourceExperiment: 'manual-candidate-01' },
}

/** Built-in recipes by id. */
export const BUILTIN_RECIPES: Readonly<Record<string, PolicyRecipe>> = {
  baseline: BASELINE_RECIPE,
  'reset-v1': RESET_V1_RECIPE,
}