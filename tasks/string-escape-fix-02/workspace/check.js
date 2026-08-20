// Deterministic grader for string-escape-fix-02. Exits 0 only when every
// assertion passes. This file must NOT be edited by the agent.
const { escapeDoubleQuoted } = require('./escape.js')

const cases = [
  ['', ''],
  ['hello', 'hello'],
  ['a"b', 'a\\"b'],
  ['"', '\\"'],
  ['\\\\', '\\\\\\\\'],
  ['a\\b', 'a\\\\b'],
  ['tab\there', 'tab\there'],
]

let failed = 0
for (const [input, expected] of cases) {
  const actual = escapeDoubleQuoted(input)
  if (actual !== expected) {
    process.stderr.write(`FAIL: escapeDoubleQuoted(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}\n`)
    failed += 1
  }
}
if (failed > 0) {
  process.stderr.write(`${failed} case(s) failed\n`)
  process.exit(1)
}
process.stdout.write('string-escape-fix-02: all grader cases passed\n')
