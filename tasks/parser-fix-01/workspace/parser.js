// A deliberately broken bracket-balance checker. The task: fix it so that
// `check.js` (the grader) passes. The bug: closing-token matching is only
// verified for parentheses — square brackets and braces pop the stack without
// checking the expected opener, so mis-nested sequences like `(]` slip
// through.
function isBalanced(input) {
  const stack = []
  for (const ch of input) {
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch)
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop()
      if (top === undefined) return false
      if (ch === ')' && top !== '(') return false
    }
  }
  return stack.length === 0
}

module.exports = { isBalanced }
