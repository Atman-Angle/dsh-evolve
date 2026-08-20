/**
 * Deterministic experience miner (v0.2, spec §6, §7.2).
 *
 * First layer of the two-layer miner: cheap, pure, replayable heuristics that
 * turn one episode into candidate experiences:
 *
 * - fact: package manager / test command / runtime / database / lockfile probes
 *   that ended in a successful tool result.
 * - correction: A → failure → user correction → B → success (spec §6.3).
 * - successful-procedure: the ordered step shape of a successful episode
 *   (spec §6.4). Steps use STRUCTURAL keys (values → type markers) so the same
 *   procedure shape merges across sessions regardless of specific arguments.
 * - failure-pattern: repeated-error / repeated-action / no-progress runs
 *   (spec §6.5).
 * - preference: derived from corrections (e.g. "pnpm over npm").
 *
 * The semantic (model-based) miner is a separate offline layer; it is never on
 * the agent hot path.
 *
 * @module dsh-evolve/experience/miner
 */

import { actionKey, canonicalArguments, parseArguments } from '../features/invocation-normalizer.js'
import { errorSignatureKey } from '../features/error-normalizer.js'
import { fingerprint } from '../features/hash.js'
import type { CollectorEvent } from '../contracts/trajectory.js'
import type { Episode } from '../episode/contracts.js'
import { finalizeCandidate } from './normalizer.js'
import type { ActionStep, CandidateExperience } from './contracts.js'

export interface MiningOptions {
  /** Repeated-error/action run length that counts as a failure pattern. */
  minPatternRepeats?: number
  /** Consecutive failed steps that count as no-progress. */
  minNoProgressSteps?: number
  /** Minimum successful tool calls for a procedure candidate. */
  minProcedureSteps?: number
  /** Cap for the truncated args kept on an ActionStep. */
  argsCap?: number
}

const DEFAULTS: Required<MiningOptions> = {
  minPatternRepeats: 3,
  minNoProgressSteps: 4,
  minProcedureSteps: 2,
  argsCap: 120,
}

const SHELL_TOOLS = new Set(['bash', 'shell', 'pwsh', 'powershell', 'cmd', 'exec'])
const FILE_TOOLS = new Set(['read', 'write', 'patch', 'glob', 'ls', 'find', 'edit'])
const MUTATION_TOOLS = new Set(['write', 'patch', 'apply', 'edit', 'create', 'rm', 'move'])

/** Structural key: sorted args with string values → `s`, numbers → `n`. */
export function structuralArgsKey(raw: string): string {
  const collapse = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(collapse)
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) out[key] = collapse(record[key])
      return out
    }
    if (typeof value === 'string') return 's'
    if (typeof value === 'number') return 'n'
    return value
  }
  return fingerprint(JSON.stringify(collapse(parseArguments(raw))))
}

/** Procedure-level step key (tool + argument SHAPE). */
export function procedureStepKey(tool: string, rawArgs: string): string {
  return fingerprint(`${tool}\u0000${structuralArgsKey(rawArgs)}`)
}

/** Extract a command string from common tool argument shapes. */
export function extractCommand(rawArgs: string): string | undefined {
  const parsed = parseArguments(rawArgs)
  if (typeof parsed === 'string') return parsed === '' ? undefined : parsed
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script', 'exec', 'input', 'args']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      return (value as string[]).join(' ')
    }
  }
  return undefined
}

interface PendingCall {
  turn: number
  step: number
  name: string
  rawArgs: string
}

interface ResultEvent {
  event: Extract<CollectorEvent, { type: 'tool/result' }>
  call: PendingCall | undefined
}

/** Walk an episode, pairing each tool/result with its originating call (FIFO). */
function pairCalls(events: readonly CollectorEvent[]): ResultEvent[] {
  const pending: PendingCall[] = []
  const out: ResultEvent[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      pending.push({
        turn: event.data.turn,
        step: event.data.step,
        name: event.data.name,
        rawArgs: event.data.arguments,
      })
    } else if (event.type === 'tool/result') {
      const idx = pending.findIndex(
        call => call.turn === event.data.turn && call.step === event.data.step,
      )
      const call = idx >= 0 ? pending.splice(idx, 1)[0] : undefined
      out.push({ event, call })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Fact detection                                                      */
/* ------------------------------------------------------------------ */

export interface FactProbe {
  subject: string
  property: string
  value: string
  scope: 'project' | 'workspace' | 'environment'
}

const PM_RE = /(^|[;&|]\s*|\s)(pnpm|npm|yarn|bun)(\s|$)/

/** Deterministic probes: `(match, value)` over a command line. */
function probeCommand(command: string): FactProbe[] {
  const out: FactProbe[] = []
  const pm = command.match(PM_RE)?.[2]
  if (pm !== undefined) {
    out.push({ subject: 'package-manager', property: 'name', value: pm, scope: 'project' })
    if (/(^|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)(\s|$)/.test(command)) {
      out.push({ subject: 'test-command', property: 'command', value: `${pm} ${/test/.test(command) ? 'test' : 'run'}`, scope: 'project' })
    }
  }
  if (/(^|\s)python3?(\s|$)/.test(command)) out.push({ subject: 'runtime', property: 'language', value: 'python', scope: 'workspace' })
  if (/(^|\s)node(\s|$)/.test(command)) out.push({ subject: 'runtime', property: 'language', value: 'node', scope: 'workspace' })
  if (/(^|\s)(psql|mysql|sqlite3|mongosh)(\s|$)/.test(command)) out.push({ subject: 'database', property: 'kind', value: 'sql', scope: 'workspace' })
  if (/postgres(\s|$)/.test(command)) out.push({ subject: 'database', property: 'kind', value: 'postgres', scope: 'project' })
  return out
}

const LOCKFILE_PM: ReadonlyArray<{ file: string; pm: string }> = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'package-lock.json', pm: 'npm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'bun.lock', pm: 'bun' },
]

function probeLockfileText(text: string): FactProbe[] {
  const out: FactProbe[] = []
  for (const entry of LOCKFILE_PM) {
    if (text.includes(entry.file)) {
      out.push({ subject: 'package-manager', property: 'name', value: entry.pm, scope: 'project' })
      out.push({ subject: 'package-manager', property: 'lockfile', value: entry.file, scope: 'project' })
    }
  }
  return out
}

/** Mine fact candidates from a paired call/result walk. */
function mineFacts(results: readonly ResultEvent[]): CandidateExperience[] {
  const probes: Array<{ probe: FactProbe; sessionEvidence: boolean }> = []
  for (const result of results) {
    if (result.event.data.isError || result.call === undefined) continue
    const call = result.call
    if (SHELL_TOOLS.has(call.name)) {
      const command = extractCommand(call.rawArgs)
      if (command !== undefined) for (const probe of probeCommand(command)) probes.push({ probe, sessionEvidence: true })
    }
    if (FILE_TOOLS.has(call.name)) {
      const text = result.event.data.contentText
      for (const probe of probeLockfileText(text)) probes.push({ probe, sessionEvidence: true })
    }
  }
  // Dedupe identical probes within the episode (count once per session).
  const seen = new Set<string>()
  const out: CandidateExperience[] = []
  for (const { probe } of probes) {
    const key = `fact:${probe.scope}:${probe.subject}:${probe.property}:${probe.value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(finalizeCandidate({
      kind: 'fact',
      sessionId: '', // filled by caller
      outcome: 'neutral',
      compatibility: {},
      payload: probe,
    }))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Correction mining                                                   */
/* ------------------------------------------------------------------ */

const PM_ORDER = ['pnpm', 'yarn', 'bun', 'npm']

function packageManagerPreference(failedCommand: string | undefined, succeededCommand: string | undefined): CandidateExperience[] {
  if (failedCommand === undefined || succeededCommand === undefined) return []
  const failed = failedCommand.match(PM_RE)?.[2]
  const succeeded = succeededCommand.match(PM_RE)?.[2]
  if (failed === undefined || succeeded === undefined || failed === succeeded) return []
  const rank = (pm: string): number => {
    const index = PM_ORDER.indexOf(pm)
    return index < 0 ? PM_ORDER.length : index
  }
  if (rank(succeeded) >= rank(failed)) return [] // only "upgrade" directions
  return [finalizeCandidate({
    kind: 'preference',
    sessionId: '',
    outcome: 'success',
    compatibility: {},
    payload: { preference: `${succeeded} over ${failed}`, over: failed, scope: 'workspace' },
  })]
}

/** Extract the step for one paired result (failed or successful). */
function stepFor(result: ResultEvent, cap: number): ActionStep | undefined {
  if (result.call === undefined) return undefined
  const raw = result.call.rawArgs
  const args = canonicalArguments(raw)
  return {
    tool: result.call.name,
    actionKey: actionKey(result.call.name, raw),
    args: args.length <= cap ? args : `${args.slice(0, cap)}…`,
  }
}

/** Mine correction candidates (A → failure → user correction → B → success). */
function mineCorrections(episode: Episode, cap: number): CandidateExperience[] {
  const out: CandidateExperience[] = []
  for (const correction of episode.corrections) {
    // Failure keys between the last success (or episode start) and the
    // correction; the NEAREST failed result becomes the failed step A.
    let failed: ResultEvent | undefined
    const failureKeys: string[] = []
    for (let i = correction.index - 1; i >= 0; i--) {
      const event = episode.events[i]
      if (event === undefined) continue
      if (event.type === 'tool/result') {
        if (event.data.isError) {
          failureKeys.push(errorSignatureKey(event.data.error ?? { text: 'unknown' }))
          if (failed === undefined) failed = { event, call: findCallBefore(episode.events, i) }
        } else {
          break // a successful step resets the failure baseline
        }
      } else if (event.type === 'user/message' || event.type === 'step/start') {
        break // do not cross into an earlier task segment
      }
    }
    // First successful result AFTER the correction with a different action.
    const failedStep = failed === undefined ? undefined : stepFor(failed, cap)
    if (failedStep === undefined) continue
    let succeeded: ActionStep | undefined
    let succeededCommand: string | undefined
    const pending: PendingCall[] = []
    for (let i = correction.index + 1; i < episode.events.length; i++) {
      const event = episode.events[i]
      if (event?.type === 'tool/call') {
        pending.push({ turn: event.data.turn, step: event.data.step, name: event.data.name, rawArgs: event.data.arguments })
      } else if (event?.type === 'tool/result' && !event.data.isError) {
        const idx = pending.findIndex(call => call.turn === event.data.turn && call.step === event.data.step)
        const call = idx >= 0 ? pending.splice(idx, 1)[0] : undefined
        if (call === undefined) continue
        const step: ActionStep = {
          tool: call.name,
          actionKey: actionKey(call.name, call.rawArgs),
          args: canonicalArguments(call.rawArgs),
        }
        if (step.actionKey !== failedStep.actionKey) {
          succeeded = { tool: step.tool, actionKey: step.actionKey, args: step.args.length <= cap ? step.args : `${step.args.slice(0, cap)}…` }
          if (SHELL_TOOLS.has(call.name)) succeededCommand = extractCommand(call.rawArgs)
          break
        }
      }
    }
    if (succeeded === undefined) continue
    const failedCommand = failedStep.tool !== undefined && SHELL_TOOLS.has(failedStep.tool)
      ? extractCommandFromArgs(failedStep.args)
      : undefined
    out.push(finalizeCandidate({
      kind: 'correction',
      sessionId: '',
      outcome: 'success',
      compatibility: {},
      payload: {
        context: 'user correction after failed tool step',
        failed: failedStep,
        succeeded,
        failureKeys,
      },
    }))
    out.push(...packageManagerPreference(failedCommand, succeededCommand))
  }
  return out
}

function extractCommandFromArgs(canonicalArgs: string): string | undefined {
  try {
    const parsed = JSON.parse(canonicalArgs) as Record<string, unknown>
    if (parsed !== null && typeof parsed === 'object') {
      const command = parsed['command']
      if (typeof command === 'string') return command
    }
  } catch {
    // not JSON — no command to extract
  }
  return undefined
}

/** Find the pending call that produced the result at index `resultIndex`. */
function findCallBefore(events: readonly CollectorEvent[], resultIndex: number): PendingCall | undefined {
  const result = events[resultIndex]
  if (result === undefined || result.type !== 'tool/result') return undefined
  const pending: PendingCall[] = []
  for (let i = resultIndex - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'tool/call') {
      pending.push({ turn: event.data.turn, step: event.data.step, name: event.data.name, rawArgs: event.data.arguments })
    } else if (event?.type === 'tool/result') {
      break // crossed into an earlier step
    }
  }
  const match = pending.reverse().find(
    call => call.turn === result.data.turn && call.step === result.data.step,
  )
  return match
}

/* ------------------------------------------------------------------ */
/* Procedure mining                                                    */
/* ------------------------------------------------------------------ */

/** Ordered structural steps of a successful episode (spec §6.4). */
function mineProcedure(episode: Episode, minSteps: number, cap: number): CandidateExperience[] {
  if (episode.outcome !== 'success' || episode.toolCalls < minSteps) return []
  if (episode.toolCalls > 40) return [] // pathological sessions are noise
  const steps: ActionStep[] = []
  const pending: PendingCall[] = []
  for (const event of episode.events) {
    if (event.type === 'tool/call') {
      pending.push({ turn: event.data.turn, step: event.data.step, name: event.data.name, rawArgs: event.data.arguments })
    } else if (event.type === 'tool/result' && !event.data.isError) {
      const idx = pending.findIndex(call => call.turn === event.data.turn && call.step === event.data.step)
      const call = idx >= 0 ? pending.splice(idx, 1)[0] : undefined
      if (call === undefined) continue
      const raw = call.rawArgs
      const args = canonicalArguments(raw)
      steps.push({
        tool: call.name,
        actionKey: procedureStepKey(call.name, raw),
        args: args.length <= cap ? args : `${args.slice(0, cap)}…`,
      })
    }
  }
  if (steps.length < minSteps) return []
  return [finalizeCandidate({
    kind: 'successful-procedure',
    sessionId: '',
    outcome: 'success',
    compatibility: {},
    payload: { context: 'successful task episode', steps },
  })]
}

/* ------------------------------------------------------------------ */
/* Failure-pattern mining                                              */
/* ------------------------------------------------------------------ */

/** Longest run of identical consecutive values; returns [value, length]. */
function longestRun<T>(values: readonly T[]): { value: T | undefined; length: number } {
  if (values.length === 0) return { value: undefined, length: 0 }
  let best: { value: T | undefined; length: number } = { value: values[0], length: 1 }
  let run = 1
  let start = 0
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[start]) {
      run += 1
    } else {
      if (run > best.length) best = { value: values[start], length: run }
      start = i
      run = 1
    }
  }
  if (run > best.length) best = { value: values[start], length: run }
  return best
}

/** Mine failure patterns: repeated errors, repeated actions, no progress. */
function mineFailurePatterns(episode: Episode, minRepeats: number, minNoProgress: number): CandidateExperience[] {
  const out: CandidateExperience[] = []
  const errorKeys: string[] = []
  const actionRuns: Array<{ key: string; failures: number }> = []
  let consecutiveFailures = 0

  for (const event of episode.events) {
    if (event.type === 'tool/result') {
      if (event.data.isError) {
        errorKeys.push(errorSignatureKey(event.data.error ?? { text: 'unknown' }))
        consecutiveFailures += 1
      } else {
        consecutiveFailures = 0
      }
    }
    if (event.type === 'tool/call') {
      const key = actionKey(event.data.name, event.data.arguments)
      const last = actionRuns[actionRuns.length - 1]
      if (last !== undefined && last.key === key) last.failures += 1
      else actionRuns.push({ key, failures: 0 })
    }
  }

  const errorRun = longestRun(errorKeys)
  if (errorRun.value !== undefined && errorRun.length >= minRepeats) {
    out.push(finalizeCandidate({
      kind: 'failure-pattern',
      sessionId: '',
      outcome: 'failure',
      compatibility: {},
      payload: {
        signature: errorRun.value,
        kind: 'repeated-error',
        repeats: errorRun.length,
        description: `same error signature repeated ${errorRun.length} times`,
        recommendedAction: 'STRATEGY_RESET',
      },
    }))
  }

  const actionRun = longestRun(actionRuns.map(run => run.key))
  if (actionRun.value !== undefined && actionRun.length >= minRepeats) {
    const failing = actionRuns.filter(run => run.key === actionRun.value)
    const failures = failing.reduce((sum, run) => sum + run.failures, 0)
    if (failures > 0) {
      out.push(finalizeCandidate({
        kind: 'failure-pattern',
        sessionId: '',
        outcome: 'failure',
        compatibility: {},
        payload: {
          signature: actionRun.value,
          kind: 'repeated-action',
          repeats: actionRun.length,
          description: `same action repeated ${actionRun.length} times with failures`,
          recommendedAction: 'STRATEGY_RESET',
        },
      }))
    }
  }

  if (consecutiveFailures >= minNoProgress) {
    out.push(finalizeCandidate({
      kind: 'failure-pattern',
      sessionId: '',
      outcome: 'failure',
      compatibility: {},
      payload: {
        signature: fingerprint(`no-progress:${consecutiveFailures}`),
        kind: 'no-progress',
        repeats: consecutiveFailures,
        description: `${consecutiveFailures} consecutive failed steps with no progress`,
        recommendedAction: 'COMPACT_OLD_TOOL_RESULTS',
      },
    }))
  }

  return out
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Mine one episode into candidate experiences. Pure and deterministic.
 * @param episode - a task-level episode.
 * @param sessionId - session that owns the episode (fills evidence provenance).
 * @param options - tunable thresholds.
 */
export function mineEpisode(episode: Episode, sessionId: string, options: MiningOptions = {}): CandidateExperience[] {
  const opts: Required<MiningOptions> = { ...DEFAULTS, ...options }
  const paired = pairCalls(episode.events)
  const candidates = [
    ...mineFacts(paired),
    ...mineCorrections(episode, opts.argsCap),
    ...mineProcedure(episode, opts.minProcedureSteps, opts.argsCap),
    ...mineFailurePatterns(episode, opts.minPatternRepeats, opts.minNoProgressSteps),
  ]
  // Assign session provenance; drop duplicates within the same episode.
  const seen = new Set<string>()
  const out: CandidateExperience[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.summaryKey)) continue
    seen.add(candidate.summaryKey)
    out.push({ ...candidate, sessionId })
  }
  return out
}

/** Whether a successful episode ended with a mutation-class tool call. */
export function endedWithMutation(episode: Episode): boolean {
  for (let i = episode.events.length - 1; i >= 0; i--) {
    const event = episode.events[i]
    if (event === undefined) continue
    if (event.type === 'tool/call' && MUTATION_TOOLS.has(event.data.name)) return true
    if (event.type === 'step/start' || event.type === 'user/message') return false
  }
  return false
}
