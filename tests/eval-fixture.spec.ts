import { describe, expect, it } from 'vitest'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGrader, spawnCommand } from '../src/offline/eval/grader.js'
import { runTaskOnce } from '../src/offline/eval/runner.js'
import type { TaskDefinition } from '../src/contracts/eval.js'

const FIXTURE = join(process.cwd(), 'tasks', 'parser-fix-01', 'workspace')

const TASK: TaskDefinition = {
  id: 'parser-fix-01',
  fixture: FIXTURE,
  prompt: join(process.cwd(), 'tasks', 'parser-fix-01', 'prompt.md'),
  grader: { commands: ['node check.js'] },
}

async function copyWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-fixture-'))
  await cp(FIXTURE, dir, { recursive: true })
  return dir
}

describe('parser-fix-01 fixture (real subprocess grader)', () => {
  it('the broken fixture fails the grader', async () => {
    const workspace = await copyWorkspace()
    const result = await runGrader(TASK, workspace)
    expect(result.passed).toBe(false)
    // Guard: the fixture really is broken (never grade a vacuous task).
    const parser = await readFile(join(workspace, 'parser.js'), 'utf8')
    expect(parser).toContain('isBalanced')
  })

  it('a correct fix passes the grader', async () => {
    const workspace = await copyWorkspace()
    const fixed = [
      'function isBalanced(input) {',
      '  const stack = []',
      '  const pairs = { ")": "(", "]": "[", "}": "{" }',
      '  for (const ch of input) {',
      '    if (ch === "(" || ch === "[" || ch === "{") { stack.push(ch); continue }',
      '    if (ch === ")" || ch === "]" || ch === "}") {',
      '      if (stack.pop() !== pairs[ch]) return false',
      '    }',
      '  }',
      '  return stack.length === 0',
      '}',
      'module.exports = { isBalanced }',
      '',
    ].join('\n')
    await writeFile(join(workspace, 'parser.js'), fixed, 'utf8')
    const result = await runGrader(TASK, workspace)
    expect(result.passed).toBe(true)
  })

  it('spawnCommand reports real failures with detail', async () => {
    const workspace = await copyWorkspace()
    const outcome = await spawnCommand('node check.js', workspace)
    expect(outcome.code).toBe(1)
    expect(outcome.stdout).toContain('FAIL: isBalanced')
  })
})

describe('additional fixtures (real subprocess graders)', () => {
  const fixtures = [
    { id: 'string-escape-fix-02', broken: 'escape.js', fixedPath: 'escape.js' },
    { id: 'dead-code-refactor-03', broken: 'mod.js', fixedPath: 'mod.js' },
  ]

  for (const fixture of fixtures) {
    const dir = join(process.cwd(), 'tasks', fixture.id, 'workspace')
    const task: TaskDefinition = {
      id: fixture.id,
      fixture: dir,
      prompt: join(process.cwd(), 'tasks', fixture.id, 'prompt.md'),
      grader: { commands: ['node check.js'] },
    }

    it(`${fixture.id}: the shipped code fails the grader (non-vacuous)`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'dsh-evolve-fixture-'))
      await cp(dir, workspace, { recursive: true })
      const result = await runGrader(task, workspace)
      expect(result.passed).toBe(false)
    })

    it(`${fixture.id}: a correct fix passes the grader`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'dsh-evolve-fixture-'))
      await cp(dir, workspace, { recursive: true })
      // A minimal correct implementation is injected by the "agent".
      const fix = fixture.id === 'string-escape-fix-02'
        ? 'function escapeDoubleQuoted(input) { return input.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, \'\\\\"\') }\nmodule.exports = { escapeDoubleQuoted }\n'
        : 'function run(input) { return input.replace(/^\\s+|\\s+$/g, "") }\nmodule.exports = { run }\n'
      await writeFile(join(workspace, fixture.fixedPath), fix, 'utf8')
      const result = await runGrader(task, workspace)
      expect(result.passed).toBe(true)
    })
  }
})

describe('runTaskOnce with the real fixture (dry-run)', () => {
  it('unpacks the fixture into the run workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-fixture-run-'))
    const cwd = join(root, 'work')
    const outcome = await runTaskOnce({
      task: TASK,
      arm: 'baseline',
      profile: 'eval-baseline',
      runId: 'fixture-dry',
      sessionId: 'fixture-sess',
      cwd,
      sessionRoot: join(root, 'sessions'),
      evalsDir: join(root, 'evals'),
      patches: [],
      launcher: async () => ({ ok: true }),
      dryRun: true,
    })
    expect(outcome.result.taskId).toBe('parser-fix-01')
    const check = await readFile(join(cwd, 'check.js'), 'utf8')
    expect(check).toContain('grader cases passed')
  })
})