/**
 * Schema-defined action enums (v0.2, spec §16).
 *
 * Public experiences can only express these actions — every enum is interpreted
 * by the CLIENT implementation, and the Commons can never add new executable
 * actions remotely.
 *
 * @module dsh-evolve/contracts/actions
 */

export const ALLOWED_ACTIONS = [
  'USE_DETECTED_PACKAGE_MANAGER',
  'PREFER_TARGETED_TEST',
  'STRATEGY_RESET',
  'REDUCE_TOOL_SURFACE',
  'EXPAND_TOOL_SURFACE',
  'COMPACT_OLD_TOOL_RESULTS',
  'MODEL_ESCALATE',
] as const

export type AllowedAction = typeof ALLOWED_ACTIONS[number]

/** Fields a public experience may NEVER carry (spec §16). */
export const PROHIBITED_FIELDS = [
  'shell',
  'exec',
  'eval',
  'http_request',
  'prompt',
  'system_instruction',
  'code',
  'script',
] as const

export function isAllowedAction(value: unknown): value is AllowedAction {
  return typeof value === 'string' && (ALLOWED_ACTIONS as readonly string[]).includes(value)
}
