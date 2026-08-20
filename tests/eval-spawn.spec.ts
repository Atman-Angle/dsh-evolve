import { describe, expect, it } from 'vitest'
import { spawnCommand } from '../src/offline/eval/grader.js'

describe('spawnCommand (real subprocess)', () => {
  it('captures stdout and exit code from a real command', async () => {
    const outcome = await spawnCommand('node -e "console.log(42)"', process.cwd())
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('42')
  })

  it('reports a non-zero exit code', async () => {
    const outcome = await spawnCommand('node -e "process.exit(3)"', process.cwd())
    expect(outcome.code).toBe(3)
  })
})