/**
 * Evolution promotion gate (v0.2 release hardening, spec §五, §七).
 *
 * System permissions and evolution permissions are SEPARATE. This gate decides
 * whether an evolution mutation may proceed, combining:
 *   - the risk-level automation permission (evolution-mode.ts), and
 *   - the always-forbidden list (system permission changes, community code),
 *     which no mode may ever auto-apply — DSH's own sandbox/approval/
 *     credentials remain the only authorities.
 *
 * @module dsh-evolve/permissions/promotion-gate
 */

import type { RiskLevel } from '../mutation/contracts.js'
import { decideEvolutionAction, type EvolutionMode, type ModeAction, type ModeOptions } from './evolution-mode.js'

export interface GateRequest {
  risk: RiskLevel
  mode: EvolutionMode
  validationPassed?: boolean
  /** Human already approved (confirm gate / explicit promote). */
  userApproved?: boolean
  /** The change would touch DSH system permissions (sandbox/approval/credentials). */
  touchesSystemPermission?: boolean
  /** The change involves community code / plugin / executable content. */
  involvesCommunityCode?: boolean
  modeOptions?: ModeOptions
}

export interface GateVerdict {
  allow: boolean
  needsUser: boolean
  action: ModeAction
  reason: string
}

/**
 * The never-automatic list (spec §六 Autopilot + §七): no mode may auto-apply
 * changes to DSH system permissions or execute community code. These are not
 * expressible by v0.2 mutations at all; the gate blocks them defensively.
 */
export function isNeverAutomatic(req: Pick<GateRequest, 'touchesSystemPermission' | 'involvesCommunityCode'>): string | undefined {
  if (req.touchesSystemPermission === true) {
    return 'touches DSH system permissions (sandbox/approval/credentials) — evolve never changes these'
  }
  if (req.involvesCommunityCode === true) {
    return 'involves community code / plugin / executable — never executed by evolve'
  }
  return undefined
}

/** Evaluate the gate (pure). */
export function evaluateGate(req: GateRequest): GateVerdict {
  const forbidden = isNeverAutomatic(req)
  if (forbidden !== undefined) {
    return { allow: false, needsUser: true, action: 'block', reason: forbidden }
  }
  const decision = decideEvolutionAction(req.risk, req.mode, req.modeOptions ?? {})
  if (decision.action === 'block') {
    return { allow: false, needsUser: true, action: 'block', reason: decision.reason }
  }
  if (decision.needsUser) {
    if (req.userApproved === true) {
      return { allow: true, needsUser: true, action: decision.action, reason: `${decision.reason} (approved by user)` }
    }
    return { allow: false, needsUser: true, action: decision.action, reason: decision.reason }
  }
  // Auto paths still require validation for shadow/eval gated risks.
  if (req.risk >= 3 && req.validationPassed !== true) {
    return { allow: false, needsUser: true, action: 'ask', reason: `risk ${req.risk} requires validation before promotion` }
  }
  return { allow: true, needsUser: false, action: decision.action, reason: decision.reason }
}

/** Human-readable permission summary for status/audit output. */
export function permissionSummary(mode: EvolutionMode): { autoPromote: string; manualApproval: string; neverAutomatic: string[] } {
  const auto = mode === 'conservative' ? '0' : mode === 'balanced' ? '0-2' : '0-2 (3-4 validated if enabled)'
  const manual = mode === 'conservative' ? '1-6' : mode === 'balanced' ? '3-6' : '3-6 (5 configurable)'
  return {
    autoPromote: auto,
    manualApproval: manual,
    neverAutomatic: [
      'modify DSH sandbox',
      'disable approval',
      'obtain credentials',
      'execute community code',
      'install third-party plugins',
      'expand system privileges',
    ],
  }
}
