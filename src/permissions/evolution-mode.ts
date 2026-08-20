/**
 * Evolution permission modes (v0.2 release hardening, spec §六).
 *
 * Three user-facing modes decide how each risk level is handled:
 *
 *   Conservative: risk 0 auto; risk 1+ ask / explicit promote.
 *   Balanced    : risk 0-1 auto; 2 shadow→auto; 3 ask; 4-5 validate+ask; 6 manual.
 *   Autopilot   : risk 0-2 auto; 3-4 validated auto IF explicitly enabled;
 *                 5 configurable (default ask); 6 never automatic.
 *
 * The gate (promotion-gate.ts) additionally enforces the never-automatic list
 * (sandbox/approval/credentials/community code/plugin install/privilege
 * escalation) regardless of mode.
 *
 * @module dsh-evolve/permissions/evolution-mode
 */

import type { RiskLevel } from '../mutation/contracts.js'

export type EvolutionMode = 'conservative' | 'balanced' | 'autopilot'

export const EVOLUTION_MODES: readonly EvolutionMode[] = ['conservative', 'balanced', 'autopilot']

export type ModeAction = 'auto-promote' | 'shadow' | 'ask' | 'block'

export interface ModeDecision {
  action: ModeAction
  needsUser: boolean
  reason: string
}

export interface ModeOptions {
  /** Validation (replay/shadow/eval) passed for the proposal. */
  validationPassed?: boolean
  /** Autopilot: explicitly enabled validated auto for risk 3-4. */
  autopilotRisk34Enabled?: boolean
  /** Autopilot: explicitly enabled auto for risk 5. */
  autopilotRisk5Enabled?: boolean
}

/** Decide how a risk level is handled in a mode (pure). */
export function decideEvolutionAction(risk: RiskLevel, mode: EvolutionMode, options: ModeOptions = {}): ModeDecision {
  switch (mode) {
    case 'conservative':
      if (risk === 0) return { action: 'auto-promote', needsUser: false, reason: 'conservative: risk 0 auto' }
      return { action: 'ask', needsUser: true, reason: `conservative: risk ${risk} requires user` }
    case 'balanced':
      if (risk <= 1) return { action: 'auto-promote', needsUser: false, reason: 'balanced: risk 0-1 auto' }
      if (risk === 2) {
        return options.validationPassed
          ? { action: 'auto-promote', needsUser: false, reason: 'balanced: risk 2 shadow validated → auto' }
          : { action: 'shadow', needsUser: false, reason: 'balanced: risk 2 shadow first' }
      }
      if (risk === 3) return { action: 'ask', needsUser: true, reason: 'balanced: risk 3 requires user approval' }
      if (risk === 4 || risk === 5) {
        return { action: 'ask', needsUser: true, reason: `balanced: risk ${risk} validate + user approval` }
      }
      return { action: 'block', needsUser: true, reason: 'balanced: risk 6 requires manual review' }
    case 'autopilot':
      if (risk <= 2) return { action: 'auto-promote', needsUser: false, reason: 'autopilot: risk 0-2 auto' }
      if (risk === 3 || risk === 4) {
        if (options.autopilotRisk34Enabled && options.validationPassed) {
          return { action: 'auto-promote', needsUser: false, reason: 'autopilot: risk 3-4 validated auto (explicitly enabled)' }
        }
        return { action: 'ask', needsUser: true, reason: 'autopilot: risk 3-4 requires approval (auto not enabled)' }
      }
      if (risk === 5) {
        if (options.autopilotRisk5Enabled && options.validationPassed) {
          return { action: 'auto-promote', needsUser: false, reason: 'autopilot: risk 5 validated auto (explicitly enabled)' }
        }
        return { action: 'ask', needsUser: true, reason: 'autopilot: risk 5 requires approval (auto not enabled)' }
      }
      return { action: 'block', needsUser: true, reason: 'autopilot: risk 6 never automatic' }
  }
}
