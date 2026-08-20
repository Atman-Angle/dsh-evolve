/**
 * Runtime overhead benchmark launcher (spec §十二).
 *
 * The benchmark implementation lives in src/offline/benchmark.ts (compiled to
 * lib/offline/benchmark.js) so it can run without a TS runtime. This launcher
 * spawns the compiled benchmark, which prints the table and writes
 * reports/audit/runtime-overhead.md.
 *
 * Usage (after `pnpm build`):
 *   node benchmarks/runtime-overhead.js        (or: pnpm benchmark)
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const compiled = join(here, '..', 'lib', 'offline', 'benchmark.js')

const result = spawnSync(process.execPath, [compiled, ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.status !== 0) {
  process.stderr.write('runtime-overhead: benchmark failed (did you run `pnpm build` first?)\n')
  process.exitCode = result.status ?? 1
}
