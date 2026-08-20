import { JsonlStore } from './jsonl-store.js'
import { fingerprint } from '../features/hash.js'
import type { CollectorEvent } from '../contracts/trajectory.js'
import type { TaskContext } from '../targets/skill-routing/store.js'

export interface SessionSnapshot {
  id: string
  sessionId: string
  events: CollectorEvent[]
  contexts: TaskContext[]
  success: boolean
  truncated: boolean
  createdAt: number
}

/** Durable, bounded input for background mining jobs. */
export class SessionSnapshotStore {
  private readonly store: JsonlStore<SessionSnapshot>

  constructor(root: string) {
    this.store = new JsonlStore(root, 'background/session-snapshots.jsonl')
  }

  static idFor(sessionId: string): string {
    return `session_${fingerprint(sessionId)}`
  }

  async put(snapshot: Omit<SessionSnapshot, 'id' | 'createdAt'>): Promise<SessionSnapshot> {
    const record: SessionSnapshot = {
      ...snapshot,
      id: SessionSnapshotStore.idFor(snapshot.sessionId),
      createdAt: Date.now(),
    }
    const existing = await this.store.read()
    const next = [...existing.filter(item => item.id !== record.id), record]
    await this.store.replaceAll(next)
    return record
  }

  async get(sessionId: string): Promise<SessionSnapshot | undefined> {
    return (await this.store.read()).find(item => item.id === SessionSnapshotStore.idFor(sessionId))
  }

  async remove(sessionId: string): Promise<void> {
    const id = SessionSnapshotStore.idFor(sessionId)
    const existing = await this.store.read()
    const next = existing.filter(item => item.id !== id)
    if (next.length !== existing.length) await this.store.replaceAll(next)
  }

  async prune(maxAgeMs: number, now = Date.now()): Promise<number> {
    const existing = await this.store.read()
    const next = existing.filter(item => now - item.createdAt <= maxAgeMs)
    if (next.length !== existing.length) await this.store.replaceAll(next)
    return existing.length - next.length
  }
}
