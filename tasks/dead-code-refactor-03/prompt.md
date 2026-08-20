# Dead Code Refactor Task

The file `mod.js` exports `run(input)` and a legacy helper `legacyTrim`.
`legacyTrim` is dead code: its only caller is `run`, and the task is to make
the module free of it.

Your task:

1. Read `mod.js` and identify the dead code.
2. Refactor so that:
   - `run(input)` trims leading/trailing whitespace exactly as before, WITHOUT
     depending on `legacyTrim` (inline the fast implementation and delete the
     legacy function), and
   - the `legacyTrim` export no longer exists.
3. Do not modify `check.js`.

You may run `node check.js` to test your refactor. The task is complete only
when `node check.js` exits with code 0.
