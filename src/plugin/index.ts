/**
 * dsh-evolve — evidence-driven runtime optimization for DeepSeek Harness.
 *
 * Cordis plugin entry: `name` / `inject` / `Config` / `apply`. Mounting this
 * plugin beside the official agent loop adds a sidecar observer that detects
 * stuck trajectories with deterministic signals and — when the active policy
 * allows — injects a STRATEGY_RESET message through the official steering
 * seams. Unmounting removes every listener and restores stock DSH behavior.
 *
 * @module dsh-evolve
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { BUILTIN_RECIPES, parseRecipe } from '../policy/recipe.js'
import type { PolicyRecipe } from '../contracts/recipe.js'
import { EvolveStore, resolveEvolveRoot } from '../storage/evolve-store.js'
import { install } from './lifecycle.js'
import { installEvolution, type EvolutionConfig } from './evolve.js'

export * from '../contracts/signals.js'
export * from '../contracts/trajectory.js'
export * from '../contracts/recipe.js'
export * from '../contracts/intervention.js'
export { StuckDetector } from '../detector/stuck-detector.js'
export { stuckScore } from '../detector/stuck-score.js'
export { FeatureExtractor, DEFAULT_MUTATION_TOOLS } from '../features/feature-extractor.js'
export { buildStrategyResetMessage } from '../intervention/strategy-reset.js'
export { summarizeSession, countPriorInjections } from './lifecycle.js'
export { resolveEvolveRoot } from '../storage/evolve-store.js'
export { installEvolution, DEFAULT_EVOLUTION_CONFIG } from './evolve.js'
export * from '../experience/contracts.js'
export * from '../mutation/contracts.js'
export { extractEpisodes } from '../episode/extractor.js'
export { mineEpisode } from '../experience/miner.js'
export { ExperienceStore } from '../experience/store.js'
export { retrieveExperiences, renderTemporaryContext } from '../experience/retriever.js'
export { MutationRegistry } from '../mutation/registry.js'
export { planMutations } from '../mutation/planner.js'
export { SkillStore } from '../targets/skill/store.js'
export { MemoryStore } from '../targets/memory/store.js'
export { ProfileStore } from '../targets/profile/store.js'
export { RoutingStore } from '../targets/skill-routing/store.js'
export { RecipeStore } from '../targets/recipe/store.js'
export { PolicyStore } from '../targets/policy/store.js'
export { compileExperience } from '../privacy/compiler.js'
export { SyncEngine } from '../commons/sync.js'

export const name = 'dsh-evolve'

/** Services the plugin needs at event time. */
export const inject = ['agents']

export interface EvolvePluginConfig {
  /** Master switch: false disables observation entirely. */
  enabled?: boolean
  /** Recipe id (`baseline` | `reset-v1`), or a path to a recipe JSON file. */
  recipe?: string
  /** Override the evolve store root (default `<DSH_HOME>|~/.dsh/evolve`). */
  storageRoot?: string
  /** v0.2 evolution sidecar config. */
  evolution?: Partial<EvolutionConfig>
}

/** Loader schema: validates and defaults the row config (fail loud). Properties are optional unless `.required()`. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  recipe: z.string().default('reset-v1'),
  storageRoot: z.string(),
  evolution: z.object({
    enabled: z.boolean().default(true),
    mining: z.boolean().default(true),
    routing: z.boolean().default(true),
    skillInjection: z.boolean().default(false),
    mode: z.union([z.const('conservative'), z.const('balanced'), z.const('autopilot')]).default('balanced'),
    background: z.object({
      maxQueueSize: z.number().default(200),
      maxAttempts: z.number().default(3),
      failureThreshold: z.number().default(3),
      cooldownMinutes: z.number().default(30),
      workerIdleMs: z.number().default(50),
    }),
    semanticMining: z.object({
      enabled: z.boolean().default(false),
      concurrency: z.number().default(1),
      maxPendingJobs: z.number().default(10),
      quotaFailurePauseMinutes: z.number().default(30),
    }),
    commons: z.object({
      enabled: z.boolean().default(false),
      syncIntervalHours: z.number().default(6),
      manifestUrl: z.string().default('https://raw.githubusercontent.com/dsh-evolve/commons/main/registry/index.json'),
    }),
  }),
})

/** Resolve the active recipe synchronously: builtin id or a JSON file (fail loud). */
export function resolveRecipe(recipe: string | undefined): PolicyRecipe {
  const id = recipe ?? 'reset-v1'
  const builtin = BUILTIN_RECIPES[id]
  if (builtin !== undefined) return builtin
  if (id.endsWith('.json')) {
    const content = readFileSync(id, 'utf8')
    return parseRecipe(JSON.parse(content))
  }
  throw new Error(`dsh-evolve: unknown recipe ${JSON.stringify(id)} — use a builtin id or a .json file path`)
}

/**
 * Plugin apply. Configuration validates fail-loud; every runtime resource is
 * registered through ctx effects and unwinds on unload.
 */
export function apply(ctx: Context, rawConfig: Partial<EvolvePluginConfig> | undefined): void {
  const config: EvolvePluginConfig = {
    enabled: rawConfig?.enabled ?? true,
    ...(rawConfig?.recipe === undefined ? {} : { recipe: rawConfig.recipe }),
    ...(rawConfig?.storageRoot === undefined ? {} : { storageRoot: rawConfig.storageRoot }),
    ...(rawConfig?.evolution === undefined ? {} : { evolution: rawConfig.evolution }),
  }
  if (typeof config.enabled !== 'boolean') {
    throw new Error('dsh-evolve: config.enabled must be a boolean')
  }
  if (config.recipe !== undefined && typeof config.recipe !== 'string') {
    throw new Error('dsh-evolve: config.recipe must be a string id or file path')
  }
  if (config.storageRoot !== undefined && typeof config.storageRoot !== 'string') {
    throw new Error('dsh-evolve: config.storageRoot must be a string path')
  }
  if (!config.enabled) return // mounted but inert — unload-safe

  const recipe = resolveRecipe(config.recipe)
  const store = new EvolveStore(
    config.storageRoot === undefined ? resolveEvolveRoot() : config.storageRoot,
  )
  install(ctx, { recipe, store })
  if (config.evolution !== undefined) {
    installEvolution(ctx, {
      root: config.storageRoot === undefined ? resolveEvolveRoot() : config.storageRoot,
      config: config.evolution,
    })
  }
}

export default apply
