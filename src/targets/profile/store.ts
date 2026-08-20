/**
 * Profile target (v0.2, Target 2 — User / Workspace Profile, risk 1).
 *
 * Long-term behavioral preferences (e.g. `pnpm over npm`). Per spec §5 these
 * never enter the Commons by default. The profile is auto-activatable but
 * always user-visible.
 *
 * @module dsh-evolve/targets/profile
 */

import { JsonlStore, assertSafeStoreId } from '../../storage/jsonl-store.js'
import type { PreferencePayload } from '../../experience/contracts.js'

export type ProfileStatus = 'DISCOVERED' | 'ACTIVE' | 'DEPRECATED' | 'REJECTED'

export interface ProfilePreference {
  id: string
  preference: PreferencePayload
  status: ProfileStatus
  /** Mutation proposal that activated this preference. */
  sourceMutationId?: string
  createdAt: string
  updatedAt: string
}

export class ProfileStore {
  private readonly store: JsonlStore<ProfilePreference>

  constructor(root: string) {
    this.store = new JsonlStore(root, 'profile/preferences.jsonl')
  }

  async list(): Promise<ProfilePreference[]> {
    return (await this.store.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listActive(): Promise<ProfilePreference[]> {
    return (await this.list()).filter(entry => entry.status === 'ACTIVE')
  }

  async getById(id: string): Promise<ProfilePreference | undefined> {
    return (await this.store.read()).find(entry => entry.id === id)
  }

  /** Upsert by preference identity (preference + over). */
  async upsert(
    preference: PreferencePayload,
    opts: { id?: string; sourceMutationId?: string; status?: ProfileStatus; now?: string } = {},
  ): Promise<ProfilePreference> {
    const now = opts.now ?? new Date().toISOString()
    const records = await this.store.read()
    const existing = records.find(entry =>
      entry.preference.preference === preference.preference
      && entry.preference.over === preference.over
    )
    if (existing !== undefined) {
      const updated: ProfilePreference = {
        ...existing,
        preference,
        status: opts.status ?? existing.status,
        ...(opts.sourceMutationId === undefined ? {} : { sourceMutationId: opts.sourceMutationId }),
        updatedAt: now,
      }
      await this.store.replaceAll(records.map(record => record.id === existing.id ? updated : record))
      return updated
    }
    const created: ProfilePreference = {
      id: opts.id ?? `pref_${now.replaceAll(/[^0-9a-z]/gi, '').slice(0, 14)}`,
      preference,
      status: opts.status ?? 'DISCOVERED',
      ...(opts.sourceMutationId === undefined ? {} : { sourceMutationId: opts.sourceMutationId }),
      createdAt: now,
      updatedAt: now,
    }
    assertSafeStoreId(created.id, 'profile id')
    await this.store.append(created)
    return created
  }

  async setStatus(id: string, status: ProfileStatus): Promise<ProfilePreference | undefined> {
    return this.store.update(id, entry => ({ ...entry, status, updatedAt: new Date().toISOString() }))
  }
}
