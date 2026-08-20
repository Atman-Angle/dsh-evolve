/**
 * Evolution sidecar (v0.2 release hardening, spec §二, §三, §四).
 *
 * Two-plane model:
 *
 *   Foreground Runtime Plane — observes DSH events, keeps a BOUNDED per-session
 *   buffer, enqueues settled sessions. O(1) per event, no network, no model,
 *   no Commons. Never blocks, never writes the durable session log.
 *
 *   Background Evolution Plane — a persistent, bounded queue + worker execute
 *   mining/planning/privacy/commons-sync at session-settled / idle time. Every
 *   handler is wrapped: a crash records a diagnostic, feeds the circuit
 *   breaker, and never escapes to the agent path.
 *
 * Invariants: evolve failure → capability paused + diagnostic → vanilla DSH
 * continues. Skills/policies only change through the approved mutation flow.
 *
 * @module dsh-evolve/plugin/evolve
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CollectorEvent } from '../contracts/trajectory.js'
import { normalizeSessionEvent } from '../collector/trajectory-collector.js'
import { extractEpisodes } from '../episode/extractor.js'
import { mineEpisode } from '../experience/miner.js'
import { ExperienceStore } from '../experience/store.js'
import { MutationRegistry } from '../mutation/registry.js'
import { planMutations } from '../mutation/planner.js'
import { SkillStore } from '../targets/skill/store.js'
import { RoutingStore, type TaskContext } from '../targets/skill-routing/store.js'
import { BackgroundQueue } from '../background/queue.js'
import { EvolutionWorker } from '../background/worker.js'
import { BreakerRegistry } from '../background/circuit-breaker.js'
import { EvolutionScheduler } from '../background/scheduler.js'
import { DiagnosticLog } from '../storage/diagnostics.js'
import type { EvolutionMode } from '../permissions/evolution-mode.js'
import { compileMany } from '../privacy/compiler.js'
import { SyncEngine } from '../commons/sync.js'
import { JsonlStore } from '../storage/jsonl-store.js'
import { SessionSnapshotStore } from '../storage/session-snapshot.js'

export interface EvolutionBackgroundConfig {
  maxQueueSize: number
  maxAttempts: number
  failureThreshold: number
  cooldownMinutes: number
  workerIdleMs: number
}

export interface EvolutionSemanticConfig {
  /** Semantic (model-based) mining — default OFF; background only when on. */
  enabled: boolean
  concurrency: number
  maxPendingJobs: number
  quotaFailurePauseMinutes: number
}

export interface EvolutionCommonsConfig {
  enabled: boolean
  syncIntervalHours: number
  /** Manifest URL (defaults to the dsh-evolve/commons release index). */
  manifestUrl: string
}

export interface EvolutionConfig {
  /** Master switch for the evolution sidecar. */
  enabled: boolean
  /** Mine sessions into experiences at session end. */
  mining: boolean
  /** Record skill-routing usage at session end. */
  routing: boolean
  /** Inject ACTIVE skill instructions through the plugin channel (off by default). */
  skillInjection: boolean
  /** Permission mode: conservative | balanced | autopilot. */
  mode: EvolutionMode
  background: EvolutionBackgroundConfig
  semanticMining: EvolutionSemanticConfig
  commons: EvolutionCommonsConfig
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  mining: true,
  routing: true,
  skillInjection: false,
  mode: 'balanced',
  background: {
    maxQueueSize: 200,
    maxAttempts: 3,
    failureThreshold: 3,
    cooldownMinutes: 30,
    workerIdleMs: 50,
  },
  semanticMining: {
    enabled: false, // never on by default (spec §十九)
    concurrency: 1,
    maxPendingJobs: 10,
    quotaFailurePauseMinutes: 30,
  },
  commons: {
    enabled: false,
    syncIntervalHours: 6,
    manifestUrl: 'https://raw.githubusercontent.com/dsh-evolve/commons/main/registry/index.json',
  },
}

/** Foreground buffers are bounded: only recent activity is retained. */
const MAX_BUFFERED_EVENTS = 2_000
const MAX_BUFFERED_SESSIONS = 64

interface SessionBuffer {
  events: CollectorEvent[]
  contexts: TaskContext[]
  success: boolean
  truncated: boolean
}

export interface EvolutionDeps {
  root: string
  config?: Partial<EvolutionConfig>
}

/** Install the evolution observers (foreground) + background worker. */
export function installEvolution(ctx: Context, deps: EvolutionDeps): void {
  const config: EvolutionConfig = mergeConfig(deps.config)
  if (!config.enabled) return

  const root = deps.root
  const buffers = new Map<string, SessionBuffer>()
  const experiences = new ExperienceStore(root)
  const mutations = new MutationRegistry(root)
  const skills = new SkillStore(root)
  const routing = new RoutingStore(root)
  const diagnostics = new DiagnosticLog(root)
  const snapshots = new SessionSnapshotStore(root)
  const breakers = new BreakerRegistry({
    failureThreshold: config.background.failureThreshold,
    cooldownMs: config.background.cooldownMinutes * 60 * 1000,
  })
  const queue = new BackgroundQueue(root, {
    maxSize: config.background.maxQueueSize,
    maxAttempts: config.background.maxAttempts,
  })

  const recordDiagnostic = (capability: string, error: unknown, context?: string): Promise<void> =>
    diagnostics.record(capability, error, context)

  const worker = new EvolutionWorker(queue, breakers, { recordDiagnostic })

  /* ------------------- background handlers ------------------- */

  worker.on('mine-session', async job => {
    const snapshot = await snapshots.get(job.payloadRef)
    const buffer = buffers.get(job.payloadRef) ?? snapshot
    if (buffer === undefined || buffer.events.length === 0) return
    if (config.mining) {
      const episodes = extractEpisodes(job.payloadRef, buffer.events)
      const candidates = episodes.flatMap(episode => mineEpisode(episode, job.payloadRef))
      if (candidates.length > 0) await experiences.merge(candidates)
    }
    if (config.routing) {
      const active = await skills.listActive()
      if (active.length > 0) {
        const summaries = active.map(skill => ({
          id: skill.id,
          name: skill.name,
          version: skill.currentVersion,
          status: skill.status,
          trigger: skill.versions[skill.versions.length - 1]?.trigger ?? {},
        }))
        for (const context of buffer.contexts) {
          const matches = await routing.recommend(summaries, context)
          for (const match of matches) {
            await routing.recordOutcome(match.skill.id, context, buffer.success)
            await skills.recordUsage(match.skill.id, buffer.success ? 'success' : 'failure')
          }
        }
      }
    }
    buffers.delete(job.payloadRef)
    await snapshots.remove(job.payloadRef)
    // Dependents are created only after mining has completed successfully.
    await queue.enqueue({ kind: 'plan-mutation', priority: 'normal', payloadRef: '' })
    await queue.enqueue({ kind: 'privacy-compile', priority: 'low', payloadRef: '' })
  })

  worker.on('plan-mutation', async () => {
    const records = await experiences.list()
    const existing = await mutations.list()
    const proposals = planMutations(records, { existingProposals: existing, distillSkill: false })
    if (proposals.length === 0) return
    await mutations.register(proposals)
    // Background mining only creates proposals. No mutation is activated
    // here: skill/policy changes require an explicit user confirmation flow.
    for (const proposal of proposals) {
      if (proposal.riskLevel >= 3) await recordDiagnostic('store', new Error(`approval required for ${proposal.id}`), 'plan-mutation')
    }
  })

  worker.on('privacy-compile', async () => {
    const records = await experiences.list()
    const shareable = records.filter(record => record.status === 'CANDIDATE' || record.status === 'ACTIVE')
    const { capsules } = compileMany(shareable)
    if (capsules.length === 0) return
    const capsuleStore = new JsonlStore<{ id: string; hash: string; kind: string; summary: string; createdAt: string }>(root, 'capsules/capsules.jsonl')
    const existing = await capsuleStore.read()
    const byHash = new Map(existing.map(entry => [entry.hash, entry]))
    for (const capsule of capsules) byHash.set(capsule.hash, { ...capsule, id: capsule.hash })
    await capsuleStore.replaceAll([...byHash.values()])
  })

  worker.on('commons-sync', async () => {
    if (!config.commons.enabled) return
    const engine = new SyncEngine(root)
    const result = await engine.sync(config.commons.manifestUrl, { interval: '6h' })
    if (result.failed.length > 0) {
      await recordDiagnostic('commons', new Error(`sync failures: ${result.failed.map(f => f.reason).join('; ')}`), 'commons-sync')
    }
  })

  // Bookkeeping kinds: no-op handlers keep the queue clean (no new features).
  worker.on('aggregate-experience', async () => undefined)
  worker.on('generate-skill-candidate', async () => undefined)
  worker.on('shadow-validate', async () => undefined)
  worker.on('maintenance', async () => {
    await snapshots.prune(24 * 60 * 60 * 1000)
  })

  const scheduler = new EvolutionScheduler({ queue, config: { commonsSyncIntervalMs: config.commons.syncIntervalHours * 60 * 60 * 1000 }, recordDiagnostic })

  /* ------------------- foreground observers ------------------- */

  ctx.on('session/event', (session: Session, sessionEvent: { time?: number }) => {
    try {
      if (typeof session?.id !== 'string') return
      let buffer = buffers.get(session.id)
      if (buffer === undefined) {
        if (buffers.size >= MAX_BUFFERED_SESSIONS) {
          const oldest = buffers.keys().next().value
          if (typeof oldest === 'string') buffers.delete(oldest)
        }
        buffer = { events: [], contexts: [], success: false, truncated: false }
        buffers.set(session.id, buffer)
      }
      const normalized = normalizeSessionEvent(sessionEvent as never)
      if (normalized === null) return
      if (buffer.events.length >= MAX_BUFFERED_EVENTS) {
        buffer.events.splice(0, Math.floor(MAX_BUFFERED_EVENTS / 2))
        buffer.truncated = true
      }
      buffer.events.push(normalized)
      if (normalized.type === 'user/message' && normalized.sourceKind === 'user') {
        buffer.contexts.push({
          ...(normalized.text === undefined ? {} : { text: normalized.text }),
          tools: [...new Set(buffer.events.filter(e => e.type === 'tool/call').map(e => (e as { data: { name: string } }).data.name))].slice(-8),
        })
      }
      if (normalized.type === 'turn/end' && /completed|success|done/i.test(normalized.reasonKind)) {
        buffer.success = true
      }
    } catch (error) {
      ctx.logger.warn(`dsh-evolve: foreground observer failed: ${String(error)}`)
    }
  })

  ctx.on('session/disposed', (session: Session) => {
    if (typeof session?.id !== 'string') return
    const buffer = buffers.get(session.id)
    if (buffer === undefined || buffer.events.length === 0) return
    void snapshots.put({
      sessionId: session.id,
      events: buffer.events,
      contexts: buffer.contexts,
      success: buffer.success,
      truncated: buffer.truncated,
    }).then(() => scheduler.enqueue('session-settled', session.id)).catch(error => {
      ctx.logger.warn(`dsh-evolve: snapshot/enqueue failed: ${String(error)}`)
    })
  })

  /* ------------------- worker lifecycle ------------------- */

  // Load persisted jobs, then run the worker until the fiber disposes.
  ctx.effect(() => {
    void (async () => {
      try {
        await queue.load()
        await writeEffectiveConfig(root, config)
        void worker.run()
      } catch (error) {
        await recordDiagnostic('store', error, 'worker-start')
      }
    })()
    return () => {
      worker.stop()
    }
  })
}

/** Deep-merge a partial config onto defaults. */
export function mergeConfig(partial: Partial<EvolutionConfig> | undefined): EvolutionConfig {
  const base = DEFAULT_EVOLUTION_CONFIG
  return {
    ...base,
    ...partial,
    background: { ...base.background, ...partial?.background },
    semanticMining: { ...base.semanticMining, ...partial?.semanticMining },
    commons: { ...base.commons, ...partial?.commons },
  }
}

/** Persist the effective config (status CLI + audit read it). */
async function writeEffectiveConfig(root: string, config: EvolutionConfig): Promise<void> {
  try {
    const path = join(root, 'config.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  } catch {
    // best-effort; config.json is informational only
  }
}
