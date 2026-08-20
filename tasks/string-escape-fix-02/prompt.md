# String Escape Fix Task

The file `escape.js` exports `escapeDoubleQuoted(input)`, which must return a
string where every double quote is escaped with a backslash and every existing
backslash is itself escaped (doubled), so the result is safe to embed inside a
double-quoted JavaScript string.

The implementation is buggy: it escapes double quotes but leaves backslashes
unchanged, so `\` sequences become ambiguous.

Your task:

1. Investigate `escape.js` to find the defect(s).
2. Fix the implementation: escape `"` as `\"` AND `\` as `\\` (a backslash
   that was already escaping something must remain escapable).
3. Do not modify `check.js`.

You may run `node check.js` to test your fix. The task is complete only when
`node check.js` exits with code 0.
