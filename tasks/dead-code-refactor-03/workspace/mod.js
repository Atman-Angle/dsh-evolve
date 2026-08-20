// Legacy module with dead code. The task: remove the unused legacy path while
// keeping `run(input)` correct and `check.js` (the grader) passing.
// The dead export `legacyTrim` must be GONE after the refactor.
function legacyTrim(input) {
  // slow legacy path, superseded by the fast path below
  return input.replace(/^\s+|\s+$/g, '')
}

function run(input) {
  return legacyTrim(input) // TODO: inline the fast trim and delete legacyTrim
}

module.exports = { run, legacyTrim }
