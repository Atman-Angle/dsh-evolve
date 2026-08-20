/**
 * dsh-evolve CLI commands (v0.2). Runs outside DSH; operates on the evolve
 * store (experiences, mutations, skills, memory, profile, routing, recipes,
 * policies, commons).
 *
 *   dsh-evolve experience mine|list|detail
 *   dsh-evolve mutations propose|list|promote|reject|rollback
 *   dsh-evolve skills list|activate|deactivate|rollback
 *   dsh-evolve memory list | profile list | recipe list
 *   dsh-evolve capsule compile|list
 *   dsh-evolve sync | contribute | status
 *
 * @module dsh-evolve/offline/commands
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CollectorEvent } from '../contracts/trajectory.js'
import { collectorEvents } from './analyzer.js'
import { listSessionArtifacts, readSessionFile } from './session-reader.js'
import { resolveEvolveRoot } from '../storage/evolve-store.js'
import { ExperienceStore } from '../experience/store.js'
import { MutationRegistry } from '../mutation/registry.js'
import { planMutations } from '../mutation/planner.js'
import { MemoryStore } from '../targets/memory/store.js'
import { ProfileStore } from '../targets/profile/store.js'
import { SkillStore } from '../targets/skill/store.js'
import { RoutingStore } from '../targets/skill-routing/store.js'
import { RecipeStore } from '../targets/recipe/store.js'
import { PolicyStore } from '../targets/policy/store.js'
import type { TargetStores } from '../targets/applier.js'
import { compileMany, compileExperience } from '../privacy/compiler.js'
import { renderCapsulePreview } from '../privacy/capsule.js'
import { JsonlStore } from '../storage/jsonl-store.js'
import { SyncEngine, type SyncInterval } from '../commons/sync.js'
import { prepareContribution, contributionCommitMessage, DEFAULT_CONTRIBUTION_POLICY } from '../commons/contribution.js'
import { mineSessionArtifacts } from './analyze/mine-sessions.js'
import { runPromotionFlow } from '../validation/promotion.js'
import { runAudit, renderAuditReport } from '../audit/report.js'
import type { AuditScope } from '../audit/contracts.js'
import { BackgroundQueue } from '../background/queue.js'
import { runOverheadBenchmark, writeOverheadReport } from './benchmark.js'
import { DiagnosticLog } from '../storage/diagnostics.js'

/* ------------------------------------------------------------------ */
/* arg parsing                                                         */
/* ------------------------------------------------------------------ */

export interface ParsedArgs {
  positional: string[]
  flags: Map<string, string>
  booleans: Set<string>
}

/** Parse `--flag value`, `--bool`, and positional args (after the command). */
export function parseFlags(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string>()
  const booleans = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next)
        i += 1
      } else {
        booleans.add(key)
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags, booleans }
}

function flagValue(args: ParsedArgs, name: string, fallback: string): string {
  return args.flags.get(name) ?? fallback
}

function isFlag(args: ParsedArgs, name: string): boolean {
  return args.booleans.has(name)
}

function requirePositional(args: ParsedArgs, label: string, count: number): string[] {
  if (args.positional.length < count) {
    throw new Error(`missing ${label} argument`)
  }
  return args.positional
}

/** First positional argument (throws when absent). */
function requiredPositional(args: ParsedArgs, label: string): string {
  const value = args.positional[0]
  if (value === undefined) throw new Error(`missing ${label} argument`)
  return value
}

/** First positional argument AFTER the subcommand (throws when absent). */
function argAfterSub(args: ParsedArgs, label: string): string {
  const value = args.positional[1]
  if (value === undefined) throw new Error(`missing ${label} argument`)
  return value
}

/* ------------------------------------------------------------------ */
/* store wiring                                                        */
/* ------------------------------------------------------------------ */

export interface OpenStores extends TargetStores {
  root: string
  experiences: ExperienceStore
  mutations: MutationRegistry
  routing: RoutingStore
}

function openStores(root: string): OpenStores {
  return {
    root,
    experiences: new ExperienceStore(root),
    mutations: new MutationRegistry(root),
    memory: new MemoryStore(root),
    profile: new ProfileStore(root),
    skills: new SkillStore(root),
    routing: new RoutingStore(root),
    recipes: new RecipeStore(root),
    policies: new PolicyStore(root),
  }
}

function rootOf(args: ParsedArgs, fallback = resolveEvolveRoot()): string {
  const explicit = args.flags.get('root')
  return explicit === undefined ? fallback : explicit
}

/** Load past sessions as CollectorEvent maps (for replay validation). */
async function loadSessions(sessionsRoot: string | undefined): Promise<Map<string, CollectorEvent[]> | undefined> {
  if (sessionsRoot === undefined) return undefined
  const artifacts = await listSessionArtifacts(sessionsRoot)
  const sessions = new Map<string, CollectorEvent[]>()
  for (const artifact of artifacts) {
    try {
      const log = await readSessionFile(artifact)
      sessions.set(log.header.id, collectorEvents(log.events))
    } catch {
      // skip corrupt artifacts
    }
  }
  return sessions
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/* ------------------------------------------------------------------ */
/* experience                                                          */
/* ------------------------------------------------------------------ */

export async function runExperienceMine(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const sessions = flagValue(args, 'sessions', join(resolveEvolveRoot(), '..', 'sessions'))
  const store = openStores(root)
  const result = await mineSessionArtifacts(sessions, store.experiences)
  if (isFlag(args, 'json')) {
    printJson(result)
  } else {
    process.stdout.write(
      `mined ${result.sessions} session(s), ${result.episodes} episode(s), ${result.candidates} candidate(s); created ${result.created.length}, updated ${result.updated.length}${result.failures.length > 0 ? `; ${result.failures.length} failure(s)` : ''}\n`,
    )
  }
  return 0
}

export async function runExperienceList(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const store = openStores(root)
  const kind = args.flags.get('kind')
  const status = args.flags.get('status')
  let records = await store.experiences.list()
  if (kind !== undefined) records = records.filter(record => record.kind === kind)
  if (status !== undefined) records = records.filter(record => record.status === status)
  if (isFlag(args, 'json')) {
    printJson(records)
  } else {
    for (const record of records) {
      process.stdout.write(`${record.id}  ${record.kind.padEnd(20)} ${record.status.padEnd(10)} c=${record.evidence.confidence} x${record.evidence.occurrences}  ${record.summary}\n`)
    }
    process.stdout.write(`${records.length} experience(s)\n`)
  }
  return 0
}

export async function runExperienceDetail(args: ParsedArgs): Promise<number> {
  const id = argAfterSub(args, '')
  const store = openStores(rootOf(args))
  const record = await store.experiences.getById(id)
  if (record === undefined) {
    process.stderr.write(`dsh-evolve: unknown experience ${id}\n`)
    return 2
  }
  printJson(record)
  return 0
}

/* ------------------------------------------------------------------ */
/* mutations                                                           */
/* ------------------------------------------------------------------ */

export async function runMutationsPropose(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const store = openStores(root)
  const experiences = await store.experiences.list()
  const existing = await store.mutations.list()
  const proposals = planMutations(experiences, { existingProposals: existing })
  const created = await store.mutations.register(proposals)
  process.stdout.write(`planned ${proposals.length} proposal(s), registered ${created.length} new\n`)
  return 0
}

export async function runMutationsList(args: ParsedArgs): Promise<number> {
  const store = openStores(rootOf(args))
  const status = args.flags.get('status')
  const target = args.flags.get('target')
  let proposals = await store.mutations.list()
  if (status !== undefined) proposals = proposals.filter(proposal => proposal.status === status)
  if (target !== undefined) proposals = proposals.filter(proposal => proposal.target === target)
  if (isFlag(args, 'json')) {
    printJson(proposals)
  } else {
    for (const proposal of proposals) {
      process.stdout.write(`${proposal.id}  ${proposal.target.padEnd(16)} ${proposal.status.padEnd(10)} risk=${proposal.riskLevel} v${proposal.version}  ${proposal.evidence.occurrences}x\n`)
    }
    process.stdout.write(`${proposals.length} proposal(s)\n`)
  }
  return 0
}

export async function runMutationsPromote(args: ParsedArgs): Promise<number> {
  const id = argAfterSub(args, '')
  const root = rootOf(args)
  const store = openStores(root)
  const approver = flagValue(args, 'approver', 'user')
  if (approver !== 'auto' && approver !== 'user' && approver !== 'policy') {
    throw new Error('--approver must be auto|user|policy')
  }
  const sessionsRoot = args.flags.get('sessions')
  const sessions = await loadSessions(sessionsRoot)
  const result = await runPromotionFlow(store.mutations, store, id, {
    approver,
    ...(sessions === undefined ? {} : { sessions }),
  })
  process.stdout.write(`promote ${id}: ${result.outcome} — ${result.detail}\n`)
  return result.outcome === 'promoted' ? 0 : 1
}

export async function runMutationsReject(args: ParsedArgs): Promise<number> {
  const id = argAfterSub(args, '')
  const store = openStores(rootOf(args))
  const reason = flagValue(args, 'reason', 'rejected via CLI')
  await store.mutations.reject(id, reason)
  process.stdout.write(`rejected ${id}\n`)
  return 0
}

export async function runMutationsRollback(args: ParsedArgs): Promise<number> {
  const id = argAfterSub(args, '')
  const store = openStores(rootOf(args))
  const reason = flagValue(args, 'reason', 'rollback via CLI')
  const rolled = await store.mutations.rollback(id, reason)
  process.stdout.write(`rolled back ${id} → ${rolled.status} (v${rolled.version})\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* skills / memory / profile / recipe                                  */
/* ------------------------------------------------------------------ */

export async function runSkillsList(args: ParsedArgs): Promise<number> {
  const store = openStores(rootOf(args))
  const status = args.flags.get('status')
  let skills = await store.skills.list()
  if (status !== undefined) skills = skills.filter(skill => skill.status === status)
  if (isFlag(args, 'json')) {
    printJson(skills)
  } else {
    for (const skill of skills) {
      process.stdout.write(`${skill.id}  ${skill.name.padEnd(28)} ${skill.status.padEnd(14)} v${skill.currentVersion} src=${skill.source} uses=${skill.usage.activations}\n`)
    }
    process.stdout.write(`${skills.length} skill(s)\n`)
  }
  return 0
}

export async function runSkillsActivate(args: ParsedArgs): Promise<number> {
  const id = argAfterSub(args, '')
  const store = openStores(rootOf(args))
  const skill = await store.skills.activate(id)
  process.stdout.write(`activated ${skill.id} (v${skill.currentVersion})\n`)
  return 0
}

export async function runSkillsDeactivate(args: ParsedArgs): Promise<number> {
  const id = argAfterSub(args, '')
  const store = openStores(rootOf(args))
  const skill = await store.skills.transition(id, 'DEPRECATED')
  process.stdout.write(`deprecated ${skill.id}\n`)
  return 0
}

export async function runSkillsRollback(args: ParsedArgs): Promise<number> {
  const id = argAfterSub(args, '')
  const store = openStores(rootOf(args))
  const reason = flagValue(args, 'reason', 'rollback via CLI')
  const skill = await store.skills.rollback(id, reason)
  process.stdout.write(`rolled back ${skill.id} → v${skill.currentVersion} (${skill.status})\n`)
  return 0
}

async function runSimpleList(args: ParsedArgs, section: 'memory' | 'profile' | 'recipe'): Promise<number> {
  const store = openStores(rootOf(args))
  if (section === 'memory') {
    const records = await store.memory.list()
    if (isFlag(args, 'json')) printJson(records)
    else for (const record of records) process.stdout.write(`${record.id}  ${record.status.padEnd(10)} ${record.fact.subject}.${record.fact.property} = ${record.fact.value}\n`)
  } else if (section === 'profile') {
    const records = await store.profile.list()
    if (isFlag(args, 'json')) printJson(records)
    else for (const record of records) process.stdout.write(`${record.id}  ${record.status.padEnd(10)} ${record.preference.preference}\n`)
  } else {
    const records = await store.recipes.list()
    if (isFlag(args, 'json')) printJson(records)
    else for (const record of records) process.stdout.write(`${record.id}  ${record.status.padEnd(10)} ${record.phases.join(' → ')}\n`)
  }
  return 0
}

/* ------------------------------------------------------------------ */
/* capsule                                                             */
/* ------------------------------------------------------------------ */

export async function runCapsuleCompile(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const store = openStores(root)
  const experienceId = args.flags.get('experience')
  const all = isFlag(args, 'all')
  let records = await store.experiences.list()
  if (experienceId !== undefined) {
    const record = records.find(entry => entry.id === experienceId)
    if (record === undefined) {
      process.stderr.write(`dsh-evolve: unknown experience ${experienceId}\n`)
      return 2
    }
    records = [record]
  } else if (!all) {
    records = records.filter(record => record.status === 'CANDIDATE' || record.status === 'ACTIVE')
  }
  const { capsules, failures } = compileMany(records)
  if (capsules.length > 0) {
    const capsuleStore = new JsonlStore<{ id: string; hash: string; kind: string; summary: string; createdAt: string }>(root, 'capsules/capsules.jsonl')
    const existing = await capsuleStore.read()
    const byHash = new Map(existing.map(entry => [entry.hash, entry]))
    for (const capsule of capsules) byHash.set(capsule.hash, { ...capsule, id: capsule.hash })
    await capsuleStore.replaceAll([...byHash.values()])
  }
  if (isFlag(args, 'json')) {
    printJson({ capsules, failures })
  } else {
    for (const capsule of capsules) {
      process.stdout.write(`${capsule.hash.slice(0, 12)}  ${capsule.kind.padEnd(14)} ${capsule.evidence.supportBucket} ${capsule.summary}\n`)
    }
    if (isFlag(args, 'preview')) {
      for (const capsule of capsules) process.stdout.write(`\n${renderCapsulePreview(capsule)}\n`)
    }
    for (const failure of failures) process.stderr.write(`rejected ${failure.id}: ${failure.errors.join('; ')}\n`)
    process.stdout.write(`${capsules.length} capsule(s) compiled, ${failures.length} rejected\n`)
  }
  return 0
}

export async function runCapsuleList(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const capsuleStore = new JsonlStore<{ id: string; hash: string; kind: string; summary: string; createdAt: string }>(root, 'capsules/capsules.jsonl')
  const capsules = await capsuleStore.read()
  if (isFlag(args, 'json')) printJson(capsules)
  else for (const capsule of capsules) process.stdout.write(`${capsule.id.slice(0, 12)}  ${capsule.kind.padEnd(14)} ${capsule.summary}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* commons                                                             */
/* ------------------------------------------------------------------ */

export async function runSync(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const url = flagValue(args, 'url', 'https://raw.githubusercontent.com/dsh-evolve/commons/main/registry/index.json')
  const interval = flagValue(args, 'interval', '6h') as SyncInterval
  if (!['startup', 'daily', '6h', 'manual', 'disabled'].includes(interval)) {
    throw new Error('--interval must be startup|daily|6h|manual|disabled')
  }
  const engine = new SyncEngine(root)
  const result = await engine.sync(url, { interval, force: isFlag(args, 'force') })
  printJson(result)
  return 0
}

export async function runContribute(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const store = openStores(root)
  const records = await store.experiences.list()
  const shareable = records.filter(record => record.status === 'CANDIDATE' || record.status === 'ACTIVE')
  const { capsules, failures } = compileMany(shareable)
  if (capsules.length === 0) {
    process.stdout.write('no shareable capsules to contribute\n')
    return 0
  }
  const release = args.flags.get('release') ?? `capsules-${new Date().toISOString().slice(0, 10)}`
  const dryRun = isFlag(args, 'dry-run')
  if (dryRun) {
    process.stdout.write(`[dry-run] ${capsules.length} capsule(s) would be contributed (release ${release})\n`)
    for (const capsule of capsules) process.stdout.write(`  ${renderCapsulePreview(capsule)}\n`)
  } else {
    const bundle = await prepareContribution(capsules, { root, release })
    process.stdout.write(`staged ${bundle.files.length} file(s) under commons/contribution/${bundle.release}/\n`)
    process.stdout.write(`commit message: ${contributionCommitMessage(bundle)}\n`)
    process.stdout.write('next: create a branch, commit, and open a PR against github.com/dsh-evolve/commons\n')
  }
  for (const failure of failures) process.stderr.write(`rejected ${failure.id}: ${failure.errors.join('; ')}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

export async function runStatus(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const store = openStores(root)
  const queue = new BackgroundQueue(root, { maxSize: 200 })
  await queue.load()
  const [experiences, mutations, skills, memory, profile, routing, recipes, policies, capsules, diagnostics] = await Promise.all([
    store.experiences.aggregate(),
    store.mutations.aggregate(),
    store.skills.list(),
    store.memory.list(),
    store.profile.list(),
    store.routing.list(),
    store.recipes.list(),
    store.policies.list(),
    new JsonlStore(root, 'capsules/capsules.jsonl').read(),
    new DiagnosticLog(root).count(),
  ])
  const pendingApproval = mutations.status['CANDIDATE'] ?? 0
  const activeMutations = mutations.status['ACTIVE'] ?? 0
  const effectiveConfig = await readEffectiveConfig(root)
  const mode = effectiveConfig.mode ?? 'balanced'
  const autoRisk = mode === 'conservative' ? '0' : '0-2'
  const manualRisk = mode === 'conservative' ? '1-6' : '3-6'
  const queueActive = queue.listActive()
  const semanticMiner = effectiveConfig.semanticMiningEnabled === true ? 'HEALTHY' : 'DISABLED'
  const status = {
    root,
    runtime: {
      observer: 'HEALTHY',
      backgroundQueue: queueActive.length,
      semanticMiner,
      commons: 'HEALTHY',
      diagnostics: diagnostics,
    },
    evolution: {
      experiences: experiences.total,
      activeMutations,
      pendingApproval,
    },
    safety: {
      mode,
      lastAudit: await lastAuditVerdict(root),
    },
    permissions: {
      autoPromoteRisk: autoRisk,
      manualApprovalRisk: manualRisk,
    },
    store: {
      skills: { total: skills.length, active: skills.filter(skill => skill.status === 'ACTIVE').length, candidates: skills.filter(skill => skill.status === 'CANDIDATE').length },
      memory: memory.length,
      profile: profile.length,
      routing: routing.length,
      recipes: recipes.length,
      policies: policies.length,
      capsules: capsules.length,
    },
  }
  if (isFlag(args, 'json')) {
    printJson(status)
  } else {
    process.stdout.write('dsh-evolve\n\nRuntime\n')
    process.stdout.write(`  observer            ${status.runtime.observer}\n`)
    process.stdout.write(`  background queue    ${queueActive.length} pending\n`)
    process.stdout.write(`  semantic miner      ${status.runtime.semanticMiner}\n`)
    process.stdout.write(`  commons             ${status.runtime.commons}\n\nEvolution\n`)
    process.stdout.write(`  experiences         ${status.evolution.experiences}\n`)
    process.stdout.write(`  active mutations     ${status.evolution.activeMutations}\n`)
    process.stdout.write(`  pending approval     ${status.evolution.pendingApproval}\n\nSafety\n`)
    process.stdout.write(`  mode                 ${status.safety.mode.toUpperCase()}\n`)
    process.stdout.write(`  last audit           ${status.safety.lastAudit}\n\nPermissions\n`)
    process.stdout.write(`  auto promote risk    ${status.permissions.autoPromoteRisk}\n`)
    process.stdout.write(`  manual approval      ${status.permissions.manualApprovalRisk}\n`)
    process.stdout.write(`  diagnostics          ${diagnostics}\n`)
  }
  return 0
}

/** Effective config written by the plugin at startup (mode + switches). */
async function readEffectiveConfig(root: string): Promise<{ mode?: string; semanticMiningEnabled?: boolean }> {
  try {
    const raw = await readFile(join(root, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw) as { mode?: string; semanticMining?: { enabled?: boolean } }
    return {
      ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
      ...(parsed.semanticMining === undefined ? {} : { semanticMiningEnabled: parsed.semanticMining.enabled }),
    }
  } catch {
    return {}
  }
}

/** Verdict from the latest audit report, if present. */
async function lastAuditVerdict(root: string): Promise<string> {
  try {
    const raw = await readFile(join(root, 'reports', 'audit', 'latest.md'), 'utf8')
    const match = raw.match(/\*\*Release Audit: (PASS|FAIL)\*\*/)
    return match?.[1] ?? 'NONE'
  } catch {
    return 'NONE'
  }
}

/* ------------------------------------------------------------------ */
/* audit + benchmark                                                   */
/* ------------------------------------------------------------------ */

export async function runAuditCommand(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const requested = args.flags.get('scope')
  let scope: AuditScope = 'all'
  if (requested !== undefined) {
    if (!['all', 'security', 'privacy', 'runtime', 'lifecycle'].includes(requested)) {
      throw new Error('--scope must be all|security|privacy|runtime|lifecycle')
    }
    scope = requested as AuditScope
  } else if (isFlag(args, 'security')) scope = 'security'
  else if (isFlag(args, 'privacy')) scope = 'privacy'
  else if (isFlag(args, 'runtime')) scope = 'runtime'
  else if (isFlag(args, 'lifecycle')) scope = 'lifecycle'

  const iterations = args.flags.get('iterations')
  const report = await runAudit(scope, {
    root,
    ...(iterations === undefined ? {} : { lifecycleIterations: Number.parseInt(iterations, 10) || 30 }),
  })
  process.stdout.write(`${renderAuditReport(report)}\n`)
  return report.pass ? 0 : 1
}

export async function runBenchmarkCommand(args: ParsedArgs): Promise<number> {
  const root = rootOf(args)
  const counts = args.positional.map(Number).filter(count => Number.isInteger(count) && count > 0)
  const result = runOverheadBenchmark(counts.length > 0 ? counts : [1_000, 10_000, 100_000])
  process.stdout.write(`events  vanilla_ms  evolve_ms  overhead_ns/ev  p95_ns  queue\n`)
  for (const sample of result.samples) {
    process.stdout.write(`${sample.events}  ${sample.vanillaMs}  ${sample.evolveMs}  ${sample.perEventOverheadNs}  ${sample.p95OverheadNs}  ≤${sample.queueGrowth}\n`)
  }
  const path = await writeOverheadReport(result, root)
  process.stdout.write(`\nverdict: ${result.pass ? 'PASS' : 'FAIL'}\nreport: ${path}\n`)
  return result.pass ? 0 : 1
}

/* ------------------------------------------------------------------ */
/* dispatcher                                                          */
/* ------------------------------------------------------------------ */

export async function runV02Command(command: string, args: ParsedArgs): Promise<number | undefined> {
  const [sub] = args.positional
  switch (command) {
    case 'experience':
      if (sub === 'mine') return runExperienceMine(args)
      if (sub === 'list') return runExperienceList(args)
      if (sub === 'detail') return runExperienceDetail(args)
      throw new Error(`unknown experience subcommand ${JSON.stringify(sub)}`)
    case 'mutations':
      if (sub === 'propose') return runMutationsPropose(args)
      if (sub === 'list') return runMutationsList(args)
      if (sub === 'promote') return runMutationsPromote(args)
      if (sub === 'reject') return runMutationsReject(args)
      if (sub === 'rollback') return runMutationsRollback(args)
      throw new Error(`unknown mutations subcommand ${JSON.stringify(sub)}`)
    case 'skills':
      if (sub === 'list') return runSkillsList(args)
      if (sub === 'activate') return runSkillsActivate(args)
      if (sub === 'deactivate') return runSkillsDeactivate(args)
      if (sub === 'rollback') return runSkillsRollback(args)
      throw new Error(`unknown skills subcommand ${JSON.stringify(sub)}`)
    case 'memory':
      if (sub === 'list') return runSimpleList(args, 'memory')
      throw new Error(`unknown memory subcommand ${JSON.stringify(sub)}`)
    case 'profile':
      if (sub === 'list') return runSimpleList(args, 'profile')
      throw new Error(`unknown profile subcommand ${JSON.stringify(sub)}`)
    case 'recipe':
      if (sub === 'list') return runSimpleList(args, 'recipe')
      throw new Error(`unknown recipe subcommand ${JSON.stringify(sub)}`)
    case 'capsule':
      if (sub === 'compile') return runCapsuleCompile(args)
      if (sub === 'list') return runCapsuleList(args)
      throw new Error(`unknown capsule subcommand ${JSON.stringify(sub)}`)
    case 'sync':
      return runSync(args)
    case 'contribute':
      return runContribute(args)
    case 'audit':
      return runAuditCommand(args)
    case 'benchmark':
      return runBenchmarkCommand(args)
    case 'status':
      return runStatus(args)
    default:
      return undefined
  }
}
