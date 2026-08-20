/**
 * Skill scanner (v0.2, spec §17, §18).
 *
 * Static scan of skill instruction text for hostile patterns. The scanner is a
 * DETECTION aid only — the harness (sandbox, tool policy, approval, capability
 * scope) remains the enforcement authority.
 *
 * @module dsh-evolve/security/skill-scanner
 */

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'info'

export interface SkillFinding {
  severity: FindingSeverity
  pattern: string
  evidence: string
}

const CRITICAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:read|cat|open|send|copy)[^;\n]*~\/\.(?:ssh|aws|gnupg|config)\b/i, label: 'credential-file-access' },
  { pattern: /(?:upload|exfiltrat|send|post|write)[^;\n]*(?:curl|wget|nc|netcat|http)[^;\n]*(?:token|key|secret|credential|env|id_rsa|\.ssh|\.aws)/i, label: 'credential-exfiltration' },
  { pattern: /(?:upload|exfiltrat|send|post|write)[^;\n]*(?:token|key|secret|credential|env|id_rsa|\.ssh|\.aws)[^;\n]*(?:curl|wget|nc|netcat|http)/i, label: 'credential-exfiltration' },
  { pattern: /(?:curl|wget|Invoke-WebRequest)[^;\n]*(?:-d|--data|--data-binary|-X\s+POST|post)[^;\n]*(?:\.env|token|key|secret|credential|password)/i, label: 'credential-exfiltration' },
  { pattern: /disable[^;\n]*(?:policy|sandbox|approval|security)/i, label: 'disable-security-policy' },
  { pattern: /bypass[^;\n]*(?:sandbox|approval|review)/i, label: 'bypass-sandbox' },
  { pattern: /(?:modify|edit|change|rewrite)[^;\n]*(?:security|policy|sandbox)[^;\n]*(?:config|allow|disable|bypass)/i, label: 'modify-security-config' },
  { pattern: /ignore[^;\n]*(?:previous|all)[^;\n]*instructions/i, label: 'prompt-injection' },
  { pattern: /(?:base64|b64)[^;\n]*(?:-d|decode|decoded|encoded|command|exec|run)/i, label: 'encoded-command' },
  { pattern: /(?:chmod|chown)[^;\n]*\b777\b/i, label: 'world-writable-permissions' },
  { pattern: /(?:curl|wget|Invoke-WebRequest)[^;\n]*(?:-o|--output|-O)[^;\n]*(?:\.sh|\.exe|\.ps1)\b/i, label: 'download-and-execute' },
]

const HIGH_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsudo\b/i, label: 'privilege-escalation' },
  { pattern: /(?:setenforce|ufw disable|iptables -F)/i, label: 'disable-firewall' },
  { pattern: /\brm\s+-rf\s+\/(?:\s|$)/i, label: 'destructive-delete' },
  { pattern: /(?:shred|wipe)[^;\n]*\b(?:disk|partition|volume)\b/i, label: 'disk-wipe' },
]

const INFO_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\beval\b|\bexec\b|\bchild_process/i, label: 'code-execution' },
  { pattern: /(?:network|http|api)[^;\n]*(?:request|call)/i, label: 'network-activity' },
]

/** Static-scan skill instruction lines. */
export function scanSkillInstructions(instructions: readonly string[]): SkillFinding[] {
  const findings: SkillFinding[] = []
  for (const line of instructions) {
    for (const entry of CRITICAL_PATTERNS) {
      if (entry.pattern.test(line)) findings.push({ severity: 'critical', pattern: entry.label, evidence: line.slice(0, 120) })
    }
    for (const entry of HIGH_PATTERNS) {
      if (entry.pattern.test(line)) findings.push({ severity: 'high', pattern: entry.label, evidence: line.slice(0, 120) })
    }
    for (const entry of INFO_PATTERNS) {
      if (entry.pattern.test(line)) findings.push({ severity: 'info', pattern: entry.label, evidence: line.slice(0, 120) })
    }
  }
  return findings
}

/** Whether a scan result blocks activation (critical findings do). */
export function scanBlocksActivation(findings: readonly SkillFinding[]): boolean {
  return findings.some(finding => finding.severity === 'critical')
}
