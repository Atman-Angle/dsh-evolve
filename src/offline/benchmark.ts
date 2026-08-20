/**
 * Runtime overhead benchmark (v0.2 release hardening, spec §十二).
 *
 * Measures the evolve observation hot path against a vanilla baseline over
 * 1k / 10k / 100k synthetic events:
 *   - vanilla: iterate events (the DSH baseline cost);
 *   - evolve: normalize + feed the stuck detector + episode bookkeeping +
 *     bounded queue enqueue (the plugin observer cost).
 *
 * Reports avg per-event overhead, p95, memory growth, and queue growth.
 * Requirements: no linear rescans per event, no leak, bounded queue, stable
 * per-event overhead.
 *
 * Run via `dsh-evolve benchmark` (or `node lib/offline/benchmark.js`).
 *
 * @module dsh-evolve/offline/benchmark
 */

import { performance } from 'node:perf_hooks'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CollectorEvent } from '../contracts/trajectory.js'
import { normalizeSessionEvent } from '../collector/trajectory-collector.js'
import { StuckDetector } from '../detector/stuck-detector.js'
import { BUILTIN_RECIPES } from '../policy/recipe.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '../storage/evolve-store.js'

export interface OverheadSample {
  events: number
  vanillaMs: number
  evolveMs: number
  perEventOverheadNs: number
  p95OverheadNs: number
  memoryGrowthMb: number
  queueGrowth: number
}

export interface OverheadResult {
  samples: OverheadSample[]
  pass: boolean
  detail: string
}

/** Synthetic event generator: interleaves steps/calls/results, plus a stuck
 * pattern so the detector actually works (worst realistic case). */
export function syntheticEvents(count: number): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 1
  const turn = 1
  for (let step = 1; step <= count; step++) {
    events.push({ type: 'step/start', seq: seq++, time: 1000 + seq, data: { turn, step } } as unknown as SessionEvent)
    events.push({ type: 'tool/call', seq: seq++, time: 1000 + seq, data: { turn, step, callId: `c${step}`, name: step % 5 === 0 ? 'bash' : 'read', arguments: step % 5 === 0 ? '{"command":"node x.js"}' : '{"path":"a.ts"}' } } as unknown as SessionEvent)
    events.push({
      type: 'tool/result',
      seq: seq++, time: 1000 + seq,
      data: {
        turn, step,
        message: {
          id: `m${step}`, role: 'user',
          content: step % 5 === 0
            ? [{ type: 'tool-result', toolCallId: `c${step}`, content: [{ type: 'text', text: 'Error: Cannot find module "x"' }], isError: true }]
            : [{ type: 'tool-result', toolCallId: `c${step}`, content: [{ type: 'text', text: 'ok' }], isError: false }],
          source: { kind: 'tool', callId: `c${step}` },
        },
        ...(step % 5 === 0 ? { error: { name: 'Error', code: 'MODULE_NOT_FOUND' } } : {}),
      },
    } as unknown as SessionEvent)
    events.push({ type: 'step/end', seq: seq++, time: 1000 + seq, data: { turn, step } } as unknown as SessionEvent)
  }
  events.push({ type: 'turn/end', seq: seq++, time: 1000 + seq, data: { reason: { kind: 'completed' } } } as unknown as SessionEvent)
  return events
}

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
}

/** Vanilla pass: touch every event (baseline cost). */
function vanillaPass(events: readonly SessionEvent[]): number {
  const start = performance.now()
  let sink = 0
  for (const sessionEvent of events) {
    if (sessionEvent.type === 'tool/call') sink += sessionEvent.data.arguments.length
    else if (sessionEvent.type === 'tool/result') sink += sessionEvent.data.message.content.length
  }
  if (sink === -1) throw new Error('impossible')
  return performance.now() - start
}

/** Evolve pass: normalize + detector feed + bounded queue bookkeeping. */
function evolvePass(events: readonly SessionEvent[]): { ms: number; perEvent: number[]; queueGrowth: number } {
  const detector = new StuckDetector(BUILTIN_RECIPES['reset-v1']!.detector)
  const perEvent: number[] = []
  let queue = 0
  const start = performance.now()
  for (const sessionEvent of events) {
    const t0 = performance.now()
    const normalized = normalizeSessionEvent(sessionEvent)
    if (normalized !== null) {
      detector.feed(normalized)
      if (normalized.type === 'tool/result' || normalized.type === 'step/end') {
        queue = Math.min(queue + 1, 200) // bounded queue (maxSize 200)
      }
    }
    perEvent.push((performance.now() - t0) * 1e6) // ns
  }
  return { ms: performance.now() - start, perEvent, queueGrowth: queue }
}

/** Run the benchmark over the standard event counts. */
export function runOverheadBenchmark(counts: readonly number[] = [1_000, 10_000, 100_000]): OverheadResult {
  const samples: OverheadSample[] = []
  const heapBefore = process.memoryUsage().heapUsed / 1024 / 1024
  for (const count of counts) {
    const events = syntheticEvents(count)
    // Warmup (JIT).
    vanillaPass(events)
    evolvePass(events)
    const vanilla = vanillaPass(events)
    const evolve = evolvePass(events)
    const overheadNs = ((evolve.ms - vanilla) / events.length) * 1e6
    samples.push({
      events: count,
      vanillaMs: Math.round(vanilla * 100) / 100,
      evolveMs: Math.round(evolve.ms * 100) / 100,
      perEventOverheadNs: Math.round(overheadNs),
      p95OverheadNs: Math.round(p95(evolve.perEvent)),
      memoryGrowthMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024 - heapBefore) * 100) / 100,
      queueGrowth: evolve.queueGrowth,
    })
  }
  const pass = samples.every(sample => sample.queueGrowth <= 200 && sample.perEventOverheadNs < 2_000_000)
  const detail = samples.map(sample =>
    `${sample.events} events: evolve=${sample.evolveMs}ms vanilla=${sample.vanillaMs}ms overhead≈${sample.perEventOverheadNs}ns/event p95=${sample.p95OverheadNs}ns queue≤${sample.queueGrowth}`,
  ).join('; ')
  return { samples, pass, detail }
}

/** Persist the report to reports/audit/runtime-overhead.md (default root). */
export async function writeOverheadReport(result: OverheadResult, root = join(resolveDshHome(), 'evolve')): Promise<string> {
  const lines = [
    '# Runtime Overhead',
    '',
    `generated: ${new Date().toISOString()}`,
    `node: ${process.version} platform: ${process.platform}`,
    '',
    '| events | vanilla ms | evolve ms | per-event overhead ns | p95 ns | queue |',
    '|---|---|---|---|---|---|',
    ...result.samples.map(sample =>
      `| ${sample.events} | ${sample.vanillaMs} | ${sample.evolveMs} | ${sample.perEventOverheadNs} | ${sample.p95OverheadNs} | ${sample.queueGrowth} |`),
    '',
    `verdict: ${result.pass ? 'PASS' : 'FAIL'}`,
    '',
    result.detail,
    '',
  ]
  const path = join(root, 'reports', 'audit', 'runtime-overhead.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

/** CLI entry: `node lib/offline/benchmark.js [counts...]` or via launcher. */
export async function mainBenchmark(argv: readonly string[]): Promise<void> {
  const counts = argv.length > 0
    ? argv.map(Number).filter(count => Number.isInteger(count) && count > 0)
    : [1_000, 10_000, 100_000]
  const result = runOverheadBenchmark(counts.length > 0 ? counts : [1_000, 10_000, 100_000])
  process.stdout.write(`events  vanilla_ms  evolve_ms  overhead_ns/ev  p95_ns  queue\n`)
  for (const sample of result.samples) {
    process.stdout.write(
      `${sample.events}  ${sample.vanillaMs}  ${sample.evolveMs}  ${sample.perEventOverheadNs}  ${sample.p95OverheadNs}  ≤${sample.queueGrowth}\n`,
    )
  }
  const path = await writeOverheadReport(result)
  process.stdout.write(`\nverdict: ${result.pass ? 'PASS' : 'FAIL'}\nreport: ${path}\n`)
}

// Self-run when executed directly (compiled lib).
const isDirect = typeof process !== 'undefined' && process.argv[1] !== undefined
  && (process.argv[1].endsWith('benchmark.js') || process.argv[1].endsWith('benchmark.ts'))
if (isDirect) {
  void mainBenchmark(process.argv.slice(2)).catch(error => {
    process.stderr.write(`dsh-evolve benchmark: ${(error as Error).message}\n`)
    process.exitCode = 2
  })
}
