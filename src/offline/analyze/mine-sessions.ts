/**
 * Offline batch mining (v0.2, spec §7, Phase 1).
 *
 * Reads stored DSH session artifacts, adapts them to the normalized trajectory
 * vocabulary, extracts episodes, mines candidates, and merges them into the
 * experience store — the "Session → Experience" pipeline run offline.
 *
 * @module dsh-evolve/offline/analyze/mine-sessions
 */

import { collectorEvents } from '../analyzer.js'
import { listSessionArtifacts, readSessionFile } from '../session-reader.js'
import { extractEpisodes } from '../../episode/extractor.js'
import { mineEpisode, type MiningOptions } from '../../experience/miner.js'
import type { ExperienceStore } from '../../experience/store.js'
import type { CandidateExperience } from '../../experience/contracts.js'

export interface MineResult {
  sessions: number
  episodes: number
  candidates: number
  created: string[]
  updated: string[]
  failures: Array<{ sessionId: string; error: string }>
}

/** Mine every session artifact under a root into the experience store. */
export async function mineSessionArtifacts(
  sessionsRoot: string,
  experienceStore: ExperienceStore,
  options: MiningOptions = {},
): Promise<MineResult> {
  const artifacts = await listSessionArtifacts(sessionsRoot)
  const result: MineResult = { sessions: 0, episodes: 0, candidates: 0, created: [], updated: [], failures: [] }
  for (const artifact of artifacts) {
    let sessionId = 'unknown'
    try {
      const log = await readSessionFile(artifact)
      sessionId = log.header.id
      const events = collectorEvents(log.events)
      const episodes = extractEpisodes(sessionId, events)
      const candidates: CandidateExperience[] = []
      for (const episode of episodes) {
        candidates.push(...mineEpisode(episode, sessionId, options))
      }
      result.episodes += episodes.length
      result.candidates += candidates.length
      const outcome = await experienceStore.merge(candidates)
      result.created.push(...outcome.created)
      result.updated.push(...outcome.updated)
      result.sessions += 1
    } catch (error) {
      result.failures.push({ sessionId, error: (error as Error).message })
    }
  }
  return result
}
