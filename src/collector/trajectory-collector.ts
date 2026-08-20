/**
 * DSH adapter: normalize durable `session/event` payloads into the plugin's
 * {@link CollectorEvent} vocabulary. This is the ONLY place that knows DSH
 * event shapes; everything downstream is DSH-agnostic and reusable by the
 * offline analyzer.
 *
 * @module dsh-evolve/collector/trajectory-collector
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CollectorEvent, ErrorSignature } from '../contracts/trajectory.js'

/** Extract displayable text from content blocks (text + reasoning only). */
function extractText(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type !== 'text' && record.type !== 'reasoning') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/** Narrow a session event into a normalized collector event, or null to skip. */
export function normalizeSessionEvent(event: SessionEvent): CollectorEvent | null {
  switch (event.type) {
    case 'step/start':
      return { type: 'step/start', turn: event.data.turn, step: event.data.step }
    case 'step/end':
      return { type: 'step/end', turn: event.data.turn, step: event.data.step }
    case 'user/message': {
      // Tolerant text extraction for routing (content may be a string or blocks).
      const content = (event.data as { content?: unknown }).content
      let text: string | undefined
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) text = extractText(content)
      return {
        type: 'user/message',
        sourceKind: event.data.source.kind,
        ...(text === undefined || text === '' ? {} : { text }),
      }
    }
    case 'tool/call':
      return {
        type: 'tool/call',
        data: {
          name: event.data.name,
          arguments: event.data.arguments,
          turn: event.data.turn,
          step: event.data.step,
        },
      }
    case 'tool/result': {
      const first = event.data.message.content[0]
      const isError = first !== undefined
        && (first as { type?: unknown; isError?: unknown }).type === 'tool-result'
        && (first as { isError?: unknown }).isError === true
      const text = extractText(
        first !== undefined && (first as { type?: unknown }).type === 'tool-result'
          ? (first as { content?: readonly unknown[] }).content ?? []
          : event.data.message.content,
      )
      const error: ErrorSignature | undefined = event.data.error === undefined
        ? undefined
        : { name: event.data.error.name, code: event.data.error.code, text }
      return {
        type: 'tool/result',
        data: {
          isError,
          ...error === undefined ? {} : { error },
          contentText: text,
          turn: event.data.turn,
          step: event.data.step,
        },
      }
    }
    case 'turn/end':
      return { type: 'turn/end', reasonKind: event.data.reason.kind }
    default:
      return null
  }
}