/**
 * Deterministic grader runner: task commands (all exit 0) plus filesystem
 * assertions. Success is decided by the machine, never by the agent's own
 * "Done." text.
 *
 * The launcher is injectable so tests can run the whole grading path without
 * spawning real processes.
 *
 * @module dsh-evolve/offline/eval/grader
 */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { FsAssertion, GraderConfig, TaskDefinition } from '../../contracts/eval.js'

export interface CommandOutcome {
  command: string
  code: number | null
  stdout: string
}

export type CommandRunner = (command: string, cwd: string) => Promise<CommandOutcome>

/** Spawn one shell command and capture its output (real default launcher). */
export const spawnCommand: CommandRunner = (command, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.on('error', reject)
  child.on('close', (code) => {
    resolve({ command, code, stdout: `${stdout}${stderr}` })
  })
})

/** Assert one filesystem condition inside the workspace. */
export async function checkAssertion(workspace: string, assertion: FsAssertion): Promise<{ ok: boolean; detail: string }> {
  const path = join(workspace, assertion.path)
  let content: string | undefined
  try {
    await access(path)
    content = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (assertion.exists === true || assertion.contains !== undefined) {
      return { ok: false, detail: `missing file ${assertion.path}` }
    }
    if (code !== 'ENOENT') return { ok: false, detail: `cannot read ${assertion.path}: ${String(error)}` }
    return { ok: true, detail: `absent as required: ${assertion.path}` }
  }
  if (assertion.exists === false) return { ok: false, detail: `file exists but required absent: ${assertion.path}` }
  if (assertion.contains !== undefined && !content.includes(assertion.contains)) {
    return { ok: false, detail: `file ${assertion.path} does not contain expected text` }
  }
  return { ok: true, detail: `ok: ${assertion.path}` }
}

export interface GraderResult {
  passed: boolean
  /** Numeric score when a scoreCommand was configured and produced one. */
  score?: number
  output: string
}

/** Run a task's full deterministic grader against a finished workspace. */
export async function runGrader(
  task: TaskDefinition,
  workspace: string,
  runner: CommandRunner = spawnCommand,
): Promise<GraderResult> {
  const output: string[] = []
  const commands = task.grader.commands ?? []
  for (const command of commands) {
    const outcome = await runner(command, workspace)
    output.push(`$ ${command} [exit ${outcome.code}]`)
    if (outcome.stdout.trim() !== '') output.push(outcome.stdout.trim())
    if (outcome.code !== 0) {
      return { passed: false, output: output.join('\n') }
    }
  }
  for (const assertion of task.grader.assertions ?? []) {
    const check = await checkAssertion(workspace, assertion)
    output.push(`assert: ${check.detail}`)
    if (!check.ok) return { passed: false, output: output.join('\n') }
  }
  let score: number | undefined
  if (task.grader.scoreCommand !== undefined) {
    const outcome = await runner(task.grader.scoreCommand, workspace)
    const parsed = Number.parseFloat(outcome.stdout.trim())
    if (outcome.code === 0 && Number.isFinite(parsed)) score = parsed
  }
  return {
    passed: true,
    output: output.join('\n'),
    ...score === undefined ? {} : { score },
  }
}