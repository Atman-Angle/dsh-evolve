import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAssertion, runGrader, type CommandOutcome, type CommandRunner } from '../src/offline/eval/grader.js'
import type { TaskDefinition } from '../src/contracts/eval.js'

const fakeRunner = (outcomes: Record<string, Partial<CommandOutcome>>): CommandRunner => async (command) => {
  const outcome = outcomes[command] ?? { code: 1, stdout: 'unexpected command' }
  return { command, code: outcome.code ?? 0, stdout: outcome.stdout ?? '' }
}

function task(grader: TaskDefinition['grader'], fixture: string): TaskDefinition {
  return { id: 't', fixture, prompt: 'prompt.md', grader }
}

describe('runGrader', () => {
  it('passes when every command exits 0 and assertions hold', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-grader-'))
    await writeFile(join(dir, 'result.txt'), 'hello world', 'utf8')
    const result = await runGrader(task({
      commands: ['build', 'test'],
      assertions: [{ path: 'result.txt', contains: 'hello' }],
    }, dir), dir, fakeRunner({ build: { code: 0 }, test: { code: 0 } }))
    expect(result.passed).toBe(true)
    expect(result.output).toContain('$ build [exit 0]')
  })

  it('fails on the first non-zero exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-grader-'))
    const result = await runGrader(task({ commands: ['build', 'test'] }, dir), dir, fakeRunner({ build: { code: 2 } }))
    expect(result.passed).toBe(false)
  })

  it('fails when a required file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-grader-'))
    const result = await runGrader(task({
      commands: [],
      assertions: [{ path: 'nope.txt', exists: true }],
    }, dir), dir, fakeRunner({}))
    expect(result.passed).toBe(false)
  })

  it('parses a numeric score from the score command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-grader-'))
    const result = await runGrader(task({ scoreCommand: 'score' }, dir), dir, fakeRunner({ score: { code: 0, stdout: '7.5\n' } }))
    expect(result.passed).toBe(true)
    expect(result.score).toBe(7.5)
  })
})

describe('checkAssertion', () => {
  it('reports absent-when-required as ok', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-grader-'))
    const check = await checkAssertion(dir, { path: 'missing', exists: false })
    expect(check.ok).toBe(true)
  })

  it('reports exists-but-forbidden as failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-grader-'))
    await writeFile(join(dir, 'leak.txt'), 'x', 'utf8')
    const check = await checkAssertion(dir, { path: 'leak.txt', exists: false })
    expect(check.ok).toBe(false)
  })

  it('reports missing expected text as failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-grader-'))
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'a.txt'), 'hello', 'utf8')
    const check = await checkAssertion(dir, { path: 'sub/a.txt', contains: 'world' })
    expect(check.ok).toBe(false)
  })
})