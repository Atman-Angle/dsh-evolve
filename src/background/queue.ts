/**
 * Background evolution queue (v0.2 release hardening, spec §三).
 *
 * A bounded, persistent, resumable job queue for the Background Evolution
 * Plane. The main agent NEVER waits on jobs: enqueue is a cheap async write;
 * full queues drop/defer low-value jobs; shutdown is safe; jobs survive
 * restart (running → pending recovery); retries are capped.
 *
 * @module dsh-evolve/background/queue
 */

import { randomUUID } from 'node:crypto'
import { JsonlStore } from '../storage/jsonl-store.js'

export type EvolutionJobKind =
  | 'mine-session'
  | 'aggregate-experience'
  | 'plan-mutation'
  | 'generate-skill-candidate'
  | 'privacy-compile'
  | 'commons-sync'
  | 'shadow-validate'
  | 'maintenance'

export type JobPriority = 'low' | 'normal'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'dropped'

export interface EvolutionJob {
  id: string
  kind: EvolutionJobKind
  priority: JobPriority
  createdAt: number
  /** Reference to the job's input (e.g. session id or payload id). */
  payloadRef: string
  attempts: number
  status: JobStatus
  lastError?: string
}

export interface QueueOptions {
  /** Max jobs kept in the queue (pending + running). Drop policy beyond this. */
  maxSize: number
  /** Max attempts per job before it is marked failed (default 3). */
  maxAttempts: number
}

export const DEFAULT_QUEUE_OPTIONS: Required<QueueOptions> = {
  maxSize: 200,
  maxAttempts: 3,
}

const KIND_WEIGHT: Record<EvolutionJobKind, number> = {
  'mine-session': 2,
  'aggregate-experience': 2,
  'plan-mutation': 2,
  'generate-skill-candidate': 3,
  'privacy-compile': 1,
  'commons-sync': 1,
  'shadow-validate': 2,
  maintenance: 0,
}

export class BackgroundQueue {
  private readonly store: JsonlStore<EvolutionJob>
  private readonly options: Required<QueueOptions>
  private readonly queue: EvolutionJob[] = []
  /** Ops wait for startup load() to finish (no load/enqueue race). */
  private ready: Promise<void> = Promise.resolve()

  constructor(root: string, options: Partial<QueueOptions> = {}) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options }
    this.store = new JsonlStore(root, 'background/queue.jsonl')
  }

  /** Load persisted jobs and recover interrupted runs (startup/resume). */
  async load(): Promise<void> {
    const loading = (async () => {
      const records = await this.store.read()
      const recovered = records.map(job => job.status === 'running' ? { ...job, status: 'pending' as const } : job)
      await this.store.replaceAll(recovered)
      this.queue.length = 0
      this.queue.push(...recovered.filter(job => job.status === 'pending'))
    })()
    this.ready = loading
    return loading
  }

  /** Number of pending + running jobs (bounded by maxSize). */
  get size(): number {
    return this.queue.length
  }

  /** Enqueue a job. Drops the LOWEST-value pending job when full. */
  async enqueue(job: Omit<EvolutionJob, 'id' | 'createdAt' | 'attempts' | 'status'>): Promise<{ enqueued: boolean; dropped?: EvolutionJob }> {
    await this.ready
    const pending = this.queue.filter(job => job.status === 'pending')
    if (pending.length >= this.options.maxSize) {
      const droppable = [...pending].sort((a, b) => {
        const weightDiff = KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind]
        if (weightDiff !== 0) return weightDiff // lower weight = drop first
        return a.createdAt - b.createdAt // older first
      })[0]
      if (droppable !== undefined && KIND_WEIGHT[droppable.kind] <= KIND_WEIGHT[job.kind]) {
        const dropped = await this.drop(droppable.id)
        if (dropped !== undefined) {
          const created: EvolutionJob = {
            id: `job_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
            kind: job.kind,
            priority: job.priority,
            createdAt: Date.now(),
            payloadRef: job.payloadRef,
            attempts: 0,
            status: 'pending',
          }
          this.queue.push(created)
          await this.append(created)
          return { enqueued: true, dropped }
        }
      }
      return { enqueued: false }
    }
    const created: EvolutionJob = {
      id: `job_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      kind: job.kind,
      priority: job.priority,
      createdAt: Date.now(),
      payloadRef: job.payloadRef,
      attempts: 0,
      status: 'pending',
    }
    this.queue.push(created)
    await this.append(created)
    return { enqueued: true }
  }

  /** Pick the highest-priority oldest pending job and mark it running. */
  async dequeue(): Promise<EvolutionJob | undefined> {
    await this.ready
    const pending = this.queue
      .filter(job => job.status === 'pending')
      .sort((a, b) => {
        const priorityDiff = (b.priority === 'normal' ? 1 : 0) - (a.priority === 'normal' ? 1 : 0)
        if (priorityDiff !== 0) return priorityDiff
        return a.createdAt - b.createdAt
      })
    const job = pending[0]
    if (job === undefined) return undefined
    const running: EvolutionJob = { ...job, status: 'running' }
    this.replaceInMemory(running)
    await this.persist()
    return running
  }

  /** Mark a job done (removed from the queue; history retained). */
  async complete(id: string): Promise<void> {
    await this.ready
    const done = this.find(id)
    if (done === undefined) return
    this.queue.splice(this.queue.indexOf(done), 1)
    await this.markTerminal(id, 'done')
  }

  /** Mark a job failed; retries are capped by maxAttempts. */
  async fail(id: string, error: string): Promise<{ retried: boolean; terminal: boolean }> {
    await this.ready
    const job = this.find(id)
    if (job === undefined) return { retried: false, terminal: true }
    const attempts = job.attempts + 1
    if (attempts >= this.options.maxAttempts) {
      this.queue.splice(this.queue.indexOf(job), 1)
      await this.markTerminal(id, 'failed', error)
      return { retried: false, terminal: true }
    }
    const updated: EvolutionJob = { ...job, status: 'pending', attempts, lastError: error }
    this.replaceInMemory(updated)
    await this.persist()
    return { retried: true, terminal: false }
  }

  /** Mark a job dropped (queue pressure / no longer valuable). */
  async drop(id: string): Promise<EvolutionJob | undefined> {
    await this.ready
    const job = this.find(id)
    if (job === undefined) return undefined
    this.queue.splice(this.queue.indexOf(job), 1)
    await this.markTerminal(id, 'dropped')
    return job
  }

  /** Pending + running jobs (for status/audit). */
  listActive(): EvolutionJob[] {
    return [...this.queue]
  }

  /** All terminal jobs in history (bounded by store growth). */
  async listTerminal(limit = 100): Promise<EvolutionJob[]> {
    const records = await this.store.read()
    return records
      .filter(job => job.status === 'done' || job.status === 'failed' || job.status === 'dropped')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  /* ---------------- internals ---------------- */

  private find(id: string): EvolutionJob | undefined {
    return this.queue.find(job => job.id === id)
  }

  private replaceInMemory(job: EvolutionJob): void {
    const index = this.queue.findIndex(entry => entry.id === job.id)
    if (index >= 0) this.queue[index] = job
  }

  private async append(job: EvolutionJob): Promise<void> {
    await this.store.append(job)
  }

  /** Rewrite the whole file so in-memory statuses match disk. */
  private async persist(): Promise<void> {
    const history = await this.store.read()
    const byId = new Map(history.map(job => [job.id, job]))
    for (const job of this.queue) byId.set(job.id, job)
    await this.store.replaceAll([...byId.values()])
  }

  private async markTerminal(id: string, status: 'done' | 'failed' | 'dropped', error?: string): Promise<void> {
    const records = await this.store.read()
    const byId = new Map(records.map(job => [job.id, job]))
    const current = byId.get(id)
    if (current === undefined) return
    byId.set(id, {
      ...current,
      status,
      ...(error === undefined ? {} : { lastError: error }),
    })
    await this.store.replaceAll([...byId.values()])
  }
}
