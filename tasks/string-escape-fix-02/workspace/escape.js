// A deliberately broken string escaper. The task: fix it so that `check.js`
// (the grader) passes. The bug: only double quotes are escaped — single
// quotes and backslashes pass through unescaped, corrupting the output.
function escapeDoubleQuoted(input) {
  let out = ''
  for (const ch of input) {
    if (ch === '"') {
      out += '\\"'
    } else {
      out += ch
    }
  }
  return out
}

module.exports = { escapeDoubleQuoted }
