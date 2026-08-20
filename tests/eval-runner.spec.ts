import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTaskOnce, locateSessionArtifact, type Launcher } from '../src/offline/eval/runner.js'
import type { TaskDefinition } from '../src/contracts/eval.js'
import { encodeSegment } from '../src/offline/session-reader.js'

function task(fixture: string): TaskDefinition {
  return {
    id: 'parser-fix-01',
    fixture,
    prompt: join(fixture, 'prompt.md'),
    grader: { commands: ['node check.js'] },
  }
}

describe('runTaskOnce', () => {
  it('dry-run: prepares the workspace and reports a placeholder result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-runner-'))
    const fixture = join(root, 'fixture')
    await mkdir(fixture)
    await writeFile(join(fixture, 'file.txt'), 'seed', 'utf8')
    const cwd = join(root, 'work')
    const outcome = await runTaskOnce({
      task: task(fixture),
      arm: 'treatment',
      profile: 'eval-treatment',
      runId: 'run-1',
      sessionId: 'sess-1',
      cwd,
      sessionRoot: join(root, 'sessions'),
      evalsDir: join(root, 'evals'),
      patches: [],
      launcher: async () => ({ ok: true }),
      dryRun: true,
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.policyId).toBe('treatment')
    // Fixture was copied into the run workspace.
    const content = await readFile(join(cwd, 'file.txt'), 'utf8')
    expect(content).toBe('seed')
  })

  it('full path with a fake launcher: analyzes the artifact and grades the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-runner-'))
    const fixture = join(root, 'fixture')
    await mkdir(fixture)
    await writeFile(join(fixture, 'check.js'), 'console.log("ok")', 'utf8')
    await writeFile(join(fixture, 'prompt.md'), 'fix it', 'utf8')

    const cwd = join(root, 'work')
    const sessionsRoot = join(root, 'sessions')
    // The fake launcher writes a session artifact that passes the grader (the
    // grader command is injected as a task prompt override + fake runner is
    // not used here, so use a real grader command that always exits 0).
    const launcher: Launcher = async (request) => {
      const project = join(sessionsRoot, 'proj')
      const sessionDir = join(project, encodeSegment(request.sessionId))
      await mkdir(sessionDir, { recursive: true })
      const header = JSON.stringify({ type: 'session', version: 0, id: request.sessionId, createdAt: 1, delegationDepth: 0 })
      const start = JSON.stringify({ type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } })
      const end = JSON.stringify({ type: 'step/end', seq: 1, time: 2, data: { turn: 1, step: 1 } })
      await writeFile(join(sessionDir, 'session.jsonl'), [header, start, end].join('\n'), 'utf8')
      return { ok: true }
    }

    const outcome = await runTaskOnce({
      task: task(fixture),
      arm: 'baseline',
      profile: 'eval-baseline',
      runId: 'run-2',
      sessionId: 'sess-2',
      cwd,
      sessionRoot: sessionsRoot,
      evalsDir: join(root, 'evals'),
      patches: [],
      launcher,
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.steps).toBe(1)
    expect(outcome.result.policyId).toBe('baseline')
    // The record was persisted.
    const record = JSON.parse(await readFile(join(root, 'evals', 'parser-fix-01', 'run-2.json'), 'utf8'))
    expect(record.steps).toBe(1)
  })

  it('marks success false when the launch failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-runner-'))
    const fixture = join(root, 'fixture')
    await mkdir(fixture)
    await writeFile(join(fixture, 'check.js'), 'console.log("ok")', 'utf8')
    await writeFile(join(fixture, 'prompt.md'), 'fix it', 'utf8')
    const outcome = await runTaskOnce({
      task: task(fixture),
      arm: 'baseline',
      profile: 'eval-baseline',
      runId: 'run-3',
      sessionId: 'sess-3',
      cwd: join(root, 'work'),
      sessionRoot: join(root, 'sessions'),
      evalsDir: join(root, 'evals'),
      patches: [],
      launcher: async () => ({ ok: false, error: 'dsh exited 1' }),
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.error).toBe('dsh exited 1')
  })
})

describe('locateSessionArtifact', () => {
  it('finds the artifact under a project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-runner-'))
    const sessionDir = join(root, 'proj', encodeSegment('sess-x'))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.jsonl'), 'line', 'utf8')
    expect(await locateSessionArtifact(root, 'sess-x')).toBe(join(sessionDir, 'session.jsonl'))
    expect(await locateSessionArtifact(root, 'sess-other')).toBeUndefined()
  })
})