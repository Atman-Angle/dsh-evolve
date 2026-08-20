/** Bounded, compatibility-aware Experience retrieval for temporary context. */
import type { Compatibility, ExperienceKind, ExperienceRecord } from './contracts.js'

export interface RetrievalContext {
  text?: string
  tools?: string[]
  domain?: string
  language?: string
  framework?: string
}

export interface RetrievedExperience {
  experience: ExperienceRecord
  relevance: number
  confidence: number
  weak: boolean
  reasons: string[]
}

export interface RetrievalOptions {
  limit?: number
  minRelevance?: number
  minConfidence?: number
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'for', 'with', 'task', 'please'])

function tokens(value: string | undefined): string[] {
  if (!value) return []
  return [...new Set(value.toLowerCase().split(/[^a-z0-9._-]+/).filter(token => token && !STOPWORDS.has(token)))]
}

function payloadText(record: ExperienceRecord): string {
  const payload = record.payload as unknown as Record<string, unknown>
  return Object.values(payload).flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === 'string')
    .join(' ')
}

function compatible(record: Compatibility, context: RetrievalContext): boolean {
  const task = record.task
  if (task?.domain && context.domain && task.domain !== context.domain) return false
  if (task?.language && context.language && task.language !== context.language) return false
  if (task?.framework && context.framework && task.framework !== context.framework) return false
  return true
}

/** Rank only local candidate/active experiences and return a bounded result. */
export function retrieveExperiences(
  records: readonly ExperienceRecord[],
  context: RetrievalContext,
  options: RetrievalOptions = {},
): RetrievedExperience[] {
  const query = new Set([...tokens(context.text), ...(context.tools ?? []).map(value => value.toLowerCase())])
  const limit = Math.max(1, Math.min(3, options.limit ?? 3))
  const minRelevance = options.minRelevance ?? 0.2
  const minConfidence = options.minConfidence ?? 0.2
  return records.flatMap(record => {
    if (record.status !== 'CANDIDATE' && record.status !== 'ACTIVE') return []
    if (!compatible(record.compatibility, context)) return []
    const haystack = new Set(tokens(`${record.summary} ${payloadText(record)}`))
    const hits = [...query].filter(token => [...haystack].some(candidate => candidate.includes(token) || token.includes(candidate)))
    const relevance = query.size === 0 ? 0 : Math.round((hits.length / query.size) * 1000) / 1000
    if (relevance < minRelevance || record.evidence.confidence < minConfidence) return []
    return [{ experience: record, relevance, confidence: record.evidence.confidence, weak: record.evidence.confidence < 0.5, reasons: hits.map(hit => `match:${hit}`) }]
  }).sort((a, b) => (b.relevance * b.confidence) - (a.relevance * a.confidence)).slice(0, limit)
}

/** Render a short task-scoped context block; callers must discard it at task end. */
export function renderTemporaryContext(matches: readonly RetrievedExperience[], maxChars = 1200): string {
  let output = ''
  for (const match of matches) {
    const line = `- ${match.experience.summary}${match.weak ? ' (weak candidate)' : ''} [${match.experience.kind as ExperienceKind}; confidence ${match.confidence}]\n`
    if (output.length + line.length > maxChars) break
    output += line
  }
  return output
}
