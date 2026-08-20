// Deterministic grader for parser-fix-01. Exits 0 only when every assertion
// passes. This file must NOT be edited by the agent (it is re-copied from the
// immutable fixture before grading).
const { isBalanced } = require('./parser.js')

const cases = [
  ['()', true],
  ['(())', true],
  ['()()', true],
  ['(()', false],
  [')(', false],
  ['([{}])', true],
  ['([)]', false],
  ['{[]()}', true],
  ['((((((', false],
  ['', true],
  ['(]', false],
  ['[)', false],
  ['{)', false],
]

let failed = 0
for (const [input, expected] of cases) {
  const actual = isBalanced(input)
  if (actual !== expected) {
    process.stderr.write(`FAIL: isBalanced(${JSON.stringify(input)}) = ${actual}, expected ${expected}\n`)
    failed += 1
  }
}
if (failed > 0) {
  process.stderr.write(`${failed} case(s) failed\n`)
  process.exit(1)
}
process.stdout.write('parser-fix-01: all grader cases passed\n')
