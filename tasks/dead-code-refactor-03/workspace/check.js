// Deterministic grader for dead-code-refactor-03. Exits 0 only when behavior
// is correct AND the dead export is gone. This file must NOT be edited.
const mod = require('./mod.js')

let failed = 0
const check = (label, actual, expected) => {
  if (actual !== expected) {
    process.stderr.write(`FAIL: ${label} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}\n`)
    failed += 1
  }
}

check('run("  x  ")', mod.run('  x  '), 'x')
check('run("")', mod.run(''), '')
check('run("a b")', mod.run('a b'), 'a b')
check('run("\\t\\n")', mod.run('\t\n'), '')

if (Object.prototype.hasOwnProperty.call(mod, 'legacyTrim')) {
  process.stderr.write('FAIL: legacyTrim must be removed (dead code)\n')
  failed += 1
}
if (failed > 0) {
  process.stderr.write(`${failed} case(s) failed\n`)
  process.exit(1)
}
process.stdout.write('dead-code-refactor-03: all grader cases passed\n')
