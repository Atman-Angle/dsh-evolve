/**
 * Eval runner: orchestrates one arm's runs over the task dataset — prepares
 * the workspace fixture, launches a DSH headless run via an injectable
 * launcher, locates the produced session artifact, grades the workspace
 * deterministically, and persists EvalRunResult records.
 *
 * Real model calls happen inside the launched DSH process; the runner itself
 * never calls a model, so the whole orchestration is testable with a fake
 * launcher and a `--dry-run`.
 *
 * @module dsh-evolve/offline/eval/runner
 */

import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extract } from './unpack.js'
import { runGrader } from './grader.js'
import { analyzeLog } from '../analyzer.js'
import { assessRecovery } from './recovery.js'
import { readSessionFile, encodeSegment } from '../session-reader.js'
import { RESET_V1_RECIPE } from '../../policy/recipe.js'
import type { EvolveStore } from '../../storage/evolve-store.js'
import type { PolicyRecipe } from '../../contracts/recipe.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { EvalRunResult, TaskDefinition } from '../../contracts/eval.js'

/** One DSH headless invocation. */
export interface LaunchRequest {
  profile: string
  /** Extra --patch overlay files (absolute paths). */
  patches: string[]
  /** Inner arguments for the headless app. */
  args: string[]
  cwd: string
  /** Explicit session identity so the run's artifact is findable. */
  sessionId: string
}

export type Launcher = (request: LaunchRequest) => Promise<{ ok: boolean; error?: string }>

/** Build the dsh command-line for one run (documented launcher flags). */
export function buildLaunchRequest(input: {
  profile: string
  taskPrompt: string
  cwd: string
  sessionId: string
  patches: string[]
}): LaunchRequest {
  return {
    profile: input.profile,
    patches: input.patches,
    args: [input.taskPrompt],
    cwd: input.cwd,
    sessionId: input.sessionId,
  }
}

export interface RunOutcome {
  result: EvalRunResult
  error?: string
}

/** Locate a session artifact for a run under the session root. */
export async function locateSessionArtifact(sessionRoot: string, sessionId: string): Promise<string | undefined> {
  // The artifact lives at <root>/<project>/<encoded-id>/session.jsonl[.zstd];
  // scan project dirs (same layout as the backend).
  const encoded = encodeSegment(sessionId)
  const projects = await readdir(sessionRoot, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const suffix of ['.jsonl.zstd', '.jsonl'] as const) {
      const path = join(sessionRoot, project.name, encoded, `session${suffix}`)
      try {
        await access(path)
        return path
      } catch {
        // continue scanning
      }
    }
  }
  return undefined
}

/** Write one eval record atomically. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/** Run one task once under one arm, writing the result to the evals store. */
export async function runTaskOnce(input: {
  task: TaskDefinition
  arm: 'baseline' | 'treatment'
  profile: string
  runId: string
  sessionId: string
  cwd: string
  sessionRoot: string
  evalsDir: string
  patches: string[]
  recipe?: PolicyRecipe
  launcher: Launcher
  taskPromptOverride?: string
  dryRun?: boolean
  /** Plugin store for Q2 recovery evidence (intervention records by session). */
  evolveStore?: EvolveStore
}): Promise<RunOutcome> {
  const { task, runId, sessionId } = input
  const startedAt = Date.now()

  // Prepare the immutable fixture workspace.
  await rm(input.cwd, { recursive: true, force: true })
  await mkdir(input.cwd, { recursive: true })
  await extract(task.fixture, input.cwd)

  if (input.dryRun === true) {
    return {
      result: {
        taskId: task.id, runId, policyId: input.arm, success: false,
        steps: 0, toolCalls: 0, durationMs: 0, stuckEvents: 0, interventions: 0,
      },
    }
  }

  const prompt = input.taskPromptOverride ?? await readFile(task.prompt, 'utf8')
  const launch = buildLaunchRequest({
    profile: input.profile,
    taskPrompt: prompt,
    cwd: input.cwd,
    sessionId,
    patches: input.patches,
  })

  const launched = await input.launcher(launch)
  const durationMs = Date.now() - startedAt

  // Collect the durable trajectory.
  let steps = 0
  let toolCalls = 0
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let stuckEvents = 0
  let interventions = 0
  let logEvents: SessionEvent[] = []
  const artifact = await locateSessionArtifact(input.sessionRoot, sessionId)
  if (artifact !== undefined) {
    const log = await readSessionFile(artifact)
    logEvents = log.events
    const analysis = analyzeLog(log.header.id, log.events, input.recipe ?? RESET_V1_RECIPE)
    steps = analysis.totalSteps
    toolCalls = analysis.totalToolCalls
    inputTokens = analysis.inputTokens
    outputTokens = analysis.outputTokens
    stuckEvents = analysis.firedEvents
    interventions = analysis.injections
  }

  // Grade deterministically (also works when the run failed at the model layer).
  const graded = await runGrader(task, input.cwd)

  // Q2 recovery assessment: fold the plugin's intervention records against
  // the run's trajectory (treatment arm only; records live in the plugin store).
  let recovered: number | undefined
  let falsePositives: number | undefined
  if (input.evolveStore !== undefined) {
    const records = await input.evolveStore.readInterventions(sessionId)
    const assessment = assessRecovery(logEvents, records, graded.passed)
    recovered = assessment.recovered
    falsePositives = assessment.falsePositives
  }

  const result: EvalRunResult = {
    taskId: task.id,
    runId,
    policyId: input.arm,
    success: launched.ok && graded.passed,
    steps,
    toolCalls,
    ...inputTokens === undefined ? {} : { inputTokens },
    ...outputTokens === undefined ? {} : { outputTokens },
    durationMs,
    stuckEvents,
    interventions,
    ...recovered === undefined ? {} : { recovered },
    ...falsePositives === undefined ? {} : { falsePositives },
    ...graded.score === undefined ? {} : { finalScore: graded.score },
  }

  await mkdir(join(input.evalsDir, task.id), { recursive: true })
  await writeJsonAtomic(join(input.evalsDir, task.id, `${runId}.json`), result)

  return launched.ok
    ? { result }
    : { result, ...launched.error === undefined ? {} : { error: launched.error } }
}