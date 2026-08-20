#!/usr/bin/env node
/**
 * dsh-evolve CLI — offline lab entry points. Runs outside DSH (never loads the
 * harness); reads stored session logs directly.
 *
 *   dsh-evolve analyze <sessionId> [--file <path>] [--root <dir>]
 *                              [--recipe <id|file>] [--json]
 *   dsh-evolve eval --tasks <tasks.json> --profile <name> --arm <baseline|treatment>
 *                   [--runs N] [--sessions <root>] [--evals <dir>] [--dry-run]
 *
 * @module dsh-evolve/offline/bin
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseRecipe, BUILTIN_RECIPES } from '../policy/recipe.js'
import { EvolveStore, resolveDshHome } from '../storage/evolve-store.js'
import { findSessionArtifact, listSessionArtifacts, readSessionFile } from './session-reader.js'
import { analyzeLog, renderReport, type AnalysisResult } from './analyzer.js'
import { runTaskOnce, type Launcher } from './eval/runner.js'
import { aggregateMetrics } from './eval/metrics.js'
import { buildReportData, renderReport as renderEvalReport } from './eval/report.js'
import { sweepTriggerScores, renderSweep } from './eval/sweep.js'
import { buildComparisonReport } from './eval/report-merge.js'
import { parseFlags, runV02Command } from './commands.js'
import type { EvalRunResult, ReportData, TaskDefinition } from '../contracts/eval.js'

interface AnalyzeArgs {
  sessionId: string
  file?: string
  root?: string
  recipe: string
  json: boolean
}

function parseArgs(argv: readonly string[]): AnalyzeArgs {
  if (argv[0] !== 'analyze') {
    throw new Error(`dsh-evolve: unknown command ${JSON.stringify(argv[0] ?? '')} — expected analyze|eval|sweep|report|experience|mutations|skills|memory|profile|recipe|capsule|sync|contribute|status`)
  }
  const sessionId = argv[1]
  if (sessionId === undefined || sessionId.startsWith('--')) {
    throw new Error('dsh-evolve: analyze requires a <sessionId> argument')
  }
  const args: AnalyzeArgs = { sessionId, recipe: 'reset-v1', json: false }
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--file': {
        if (value === undefined) throw new Error('dsh-evolve: --file requires a path')
        args.file = value
        i += 1
        break
      }
      case '--root': {
        if (value === undefined) throw new Error('dsh-evolve: --root requires a path')
        args.root = value
        i += 1
        break
      }
      case '--recipe': {
        if (value === undefined) throw new Error('dsh-evolve: --recipe requires an id or file path')
        args.recipe = value
        i += 1
        break
      }
      case '--json':
        args.json = true
        break
      default:
        throw new Error(`dsh-evolve: unknown flag ${JSON.stringify(flag)}`)
    }
  }
  return args
}

export async function runAnalyzeCommand(args: AnalyzeArgs): Promise<number> {
  const builtin = BUILTIN_RECIPES[args.recipe]
  const recipe = builtin !== undefined
    ? builtin
    : args.recipe.endsWith('.json')
      ? parseRecipe(JSON.parse(await readFile(args.recipe, 'utf8')))
      : parseRecipe(JSON.parse(args.recipe))

  const source = args.file ?? await findSessionArtifact(
    args.root ?? join(resolveDshHome(), 'sessions'),
    args.sessionId,
  )
  if (source === undefined) {
    process.stderr.write(`dsh-evolve: no session artifact found for ${args.sessionId}\n`)
    return 2
  }
  const log = await readSessionFile(source)
  const result: AnalysisResult = analyzeLog(log.header.id, log.events, recipe)
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderReport(result, recipe)}\n`)
  }
  return 0
}

/** Spawn the real `dsh` CLI for one run (the default launcher). */
export const dshLauncher: Launcher = (request) => new Promise((resolve) => {
  const args = ['--profile', request.profile]
  for (const patch of request.patches) args.push('--patch', patch)
  const child = spawn('dsh', [...args, ...request.args], {
    cwd: request.cwd,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  child.on('error', (error) => resolve({ ok: false, error: String(error) }))
  child.on('close', (code) => resolve(code === 0
    ? { ok: true }
    : { ok: false, error: `dsh exited ${code}` }))
})

interface EvalArgs {
  tasks: string
  profile: string
  arm: 'baseline' | 'treatment'
  runs: number
  sessions: string
  evals: string
  workdir: string
  dryRun: boolean
  reportPath: string
}

function parseEvalArgs(argv: readonly string[]): EvalArgs {
  if (argv[0] !== 'eval') throw new Error('dsh-evolve: unknown command — expected "analyze" or "eval"')
  const args: EvalArgs = {
    tasks: '', profile: '', arm: 'baseline', runs: 1,
    sessions: join(resolveDshHome(), 'sessions'),
    evals: join(resolveDshHome(), 'evolve', 'evals'),
    workdir: join(resolveDshHome(), 'evolve', 'work'),
    dryRun: false,
    reportPath: join(resolveDshHome(), 'evolve', 'reports', 'latest.md'),
  }
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    const take = (): string => {
      if (value === undefined) throw new Error(`dsh-evolve: ${flag} requires a value`)
      i += 1
      return value
    }
    switch (flag) {
      case '--tasks': args.tasks = take(); break
      case '--profile': args.profile = take(); break
      case '--arm': {
        const arm = take()
        if (arm !== 'baseline' && arm !== 'treatment') throw new Error('dsh-evolve: --arm must be baseline|treatment')
        args.arm = arm
        break
      }
      case '--runs': {
        const runs = Number.parseInt(take(), 10)
        if (!Number.isInteger(runs) || runs < 1) throw new Error('dsh-evolve: --runs must be a positive integer')
        args.runs = runs
        break
      }
      case '--sessions': args.sessions = take(); break
      case '--evals': args.evals = take(); break
      case '--workdir': args.workdir = take(); break
      case '--report': args.reportPath = take(); break
      case '--dry-run': args.dryRun = true; break
      default: throw new Error(`dsh-evolve: unknown flag ${JSON.stringify(flag)}`)
    }
  }
  if (args.tasks === '') throw new Error('dsh-evolve: eval requires --tasks <file.json>')
  if (args.profile === '') throw new Error('dsh-evolve: eval requires --profile <name>')
  return args
}

/** Run one arm over the task dataset; persist results and an arm report. */
export async function runEvalCommand(args: EvalArgs): Promise<number> {
  const raw = await readFile(args.tasks, 'utf8')
  const tasks = (JSON.parse(raw) as { tasks: TaskDefinition[] }).tasks
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('dsh-evolve: tasks file must contain a non-empty "tasks" array')
  }
  await mkdir(join(args.evals, '_runs'), { recursive: true })

  const outcomes: EvalRunResult[] = []
  for (let run = 0; run < args.runs; run++) {
    for (const task of tasks) {
      const runId = `${task.id}-${args.arm}-${randomUUID().slice(0, 8)}`
      const cwd = join(args.workdir, runId)
      const outcome = await runTaskOnce({
        task,
        arm: args.arm,
        profile: args.profile,
        runId,
        sessionId: `eval-${args.arm}-${runId}`,
        cwd,
        sessionRoot: args.sessions,
        evalsDir: args.evals,
        patches: [],
        launcher: dshLauncher,
        dryRun: args.dryRun,
        ...args.arm === 'treatment' ? { evolveStore: new EvolveStore(join(resolveDshHome(), 'evolve')) } : {},
      })
      outcomes.push(outcome.result)
      process.stderr.write(`eval: ${runId} ${outcome.result.success ? 'PASS' : 'FAIL'} (steps=${outcome.result.steps})\n`)
    }
  }

  // Single-arm run: report the arm's metrics; the two-arm comparison arrives
  // once both arms have been run (see experiment-design.md §5).
  const armMetrics = aggregateMetrics(outcomes)
  const comparison = {
    baseline: armMetrics,
    treatment: armMetrics,
    successDeltaPp: 0,
    avgStepsDelta: 0,
    avgInputTokensDelta: 0,
    avgDurationMsDelta: 0,
    stuckRateDeltaPp: 0,
    treatmentInterventions: armMetrics.totalInterventions,
    recovered: 0,
    falsePositives: 0,
  }
  const report: ReportData = buildReportData({
    comparison,
    cases: [],
    tasks: tasks.length,
    baselineRuns: args.arm === 'baseline' ? outcomes.length : 0,
    treatmentRuns: args.arm === 'treatment' ? outcomes.length : 0,
    generatedAt: new Date().toISOString(),
  })
  await mkdir(dirname(args.reportPath), { recursive: true })
  await writeFile(args.reportPath, `${renderEvalReport(report)}\n`, 'utf8')
  process.stdout.write(`eval: ${outcomes.length} runs recorded; report -> ${args.reportPath}\n`)
  return 0
}

/** Q1 sweep: grid-scan the trigger score over a session corpus. */
interface SweepArgs {
  root: string
  scores: number[]
  recipe: string
  json: boolean
}

function parseSweepArgs(argv: readonly string[]): SweepArgs {
  const args: SweepArgs = {
    root: join(resolveDshHome(), 'sessions'),
    scores: [0.4, 0.5, 0.6, 0.65, 0.7, 0.8, 0.9],
    recipe: 'reset-v1',
    json: false,
  }
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    const take = (): string => {
      if (value === undefined) throw new Error(`dsh-evolve: ${flag} requires a value`)
      i += 1
      return value
    }
    switch (flag) {
      case '--root': args.root = take(); break
      case '--recipe': args.recipe = take(); break
      case '--json': args.json = true; break
      case '--scores': {
        args.scores = take().split(',').map(entry => Number.parseFloat(entry.trim()))
        if (args.scores.some(value => !Number.isFinite(value))) {
          throw new Error('dsh-evolve: --scores must be comma-separated numbers')
        }
        break
      }
      default: throw new Error(`dsh-evolve: unknown flag ${JSON.stringify(flag)}`)
    }
  }
  return args
}

export async function runSweepCommand(args: SweepArgs): Promise<number> {
  const builtin = BUILTIN_RECIPES[args.recipe]
  const recipe: import('../contracts/recipe.js').PolicyRecipe = builtin !== undefined
    ? builtin
    : args.recipe.endsWith('.json')
      ? parseRecipe(JSON.parse(await readFile(args.recipe, 'utf8')))
      : parseRecipe(JSON.parse(args.recipe))

  const artifacts = await listSessionArtifacts(args.root)
  if (artifacts.length === 0) {
    process.stderr.write(`dsh-evolve: no session artifacts found under ${args.root}\n`)
    return 2
  }
  const sessions = new Map<string, readonly import('@deepseek-ai/dsh-session').SessionEvent[]>()
  for (const path of artifacts) {
    const log = await readSessionFile(path)
    sessions.set(log.header.id, log.events)
  }
  const result = sweepTriggerScores(sessions, args.scores, recipe.detector)
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderSweep(result)}\n`)
  }
  return 0
}

/** Merge two arms' eval records into the full comparison report. */
interface ReportArgs {
  baseline: string
  treatment: string
  reportPath: string
  tasks?: number
  model?: string
  cases?: string
}

function parseReportArgs(argv: readonly string[]): ReportArgs {
  if (argv[0] !== 'report') throw new Error('dsh-evolve: unknown command — expected analyze|eval|sweep|report')
  const args: ReportArgs = {
    baseline: '', treatment: '', reportPath: join(resolveDshHome(), 'evolve', 'reports', 'latest.md'),
  }
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    const take = (): string => {
      if (value === undefined) throw new Error(`dsh-evolve: ${flag} requires a value`)
      i += 1
      return value
    }
    switch (flag) {
      case '--baseline': args.baseline = take(); break
      case '--treatment': args.treatment = take(); break
      case '--report': args.reportPath = take(); break
      case '--tasks': {
        const parsed = Number.parseInt(take(), 10)
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error('dsh-evolve: --tasks must be a non-negative integer')
        args.tasks = parsed
        break
      }
      case '--model': args.model = take(); break
      case '--cases': args.cases = take(); break
      default: throw new Error(`dsh-evolve: unknown flag ${JSON.stringify(flag)}`)
    }
  }
  if (args.baseline === '' || args.treatment === '') {
    throw new Error('dsh-evolve: report requires --baseline <evalsDir> and --treatment <evalsDir>')
  }
  return args
}

export async function runReportCommand(args: ReportArgs): Promise<number> {
  const cases = args.cases === undefined ? undefined : (JSON.parse(await readFile(args.cases, 'utf8')) as { cases: import('../contracts/eval.js').CaseNote[] }).cases
  const report = await buildComparisonReport({
    baselineEvals: args.baseline,
    treatmentEvals: args.treatment,
    ...args.tasks === undefined ? {} : { tasks: args.tasks },
    ...args.model === undefined ? {} : { model: args.model },
    ...cases === undefined ? {} : { cases },
  })
  await mkdir(dirname(args.reportPath), { recursive: true })
  await writeFile(args.reportPath, `${renderEvalReport(report)}\n`, 'utf8')
  process.stdout.write(`report -> ${args.reportPath}\n`)
  return 0
}

async function main(argv: readonly string[]): Promise<void> {
  try {
    // v0.2 commands: experience / mutations / skills / memory / profile /
    // recipe / capsule / sync / contribute / status (see commands.ts)
    const command = argv[0]
    if (command !== undefined
      && (command === 'experience' || command === 'mutations' || command === 'skills'
        || command === 'memory' || command === 'profile' || command === 'recipe'
        || command === 'capsule' || command === 'sync' || command === 'contribute'
        || command === 'status' || command === 'audit' || command === 'benchmark')) {
      const exitCode = await runV02Command(command, parseFlags(argv.slice(1)))
      if (exitCode !== undefined) {
        process.exitCode = exitCode
        return
      }
    }
    if (command === 'eval') {
      process.exitCode = await runEvalCommand(parseEvalArgs(argv))
      return
    }
    if (command === 'sweep') {
      process.exitCode = await runSweepCommand(parseSweepArgs(argv))
      return
    }
    if (command === 'report') {
      process.exitCode = await runReportCommand(parseReportArgs(argv))
      return
    }
    const args = parseArgs(argv)
    process.exitCode = await runAnalyzeCommand(args)
  } catch (error: unknown) {
    process.stderr.write(`dsh-evolve: ${(error as Error).message ?? String(error)}\n`)
    process.exitCode = 2
  }
}

void main(process.argv.slice(2))