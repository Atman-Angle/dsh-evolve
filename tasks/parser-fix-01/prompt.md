# Parser Fix Task

The file `parser.js` exports `isBalanced(input)`, which should return `true`
when the input string's brackets `() [] {}` are balanced and properly nested.

There is a bug in the implementation: some inputs produce the wrong answer.

Your task:

1. Investigate `parser.js` to find the defect(s).
2. Fix the implementation so that every reasonable bracket sequence is
   classified correctly: balanced and properly nested sequences return
   `true`; unbalanced or mis-nested sequences return `false`.
3. Do not modify `check.js` — it is the grading harness and will be reset.

You may run `node check.js` to test your fix. The task is complete only when
`node check.js` exits with code 0 and prints the success message.
