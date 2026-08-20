/**
 * Privilege audit (v0.2 release hardening, spec §八).
 *
 * Source-level scan for high-privilege API usage. Every match is classified
 * (why / required capability / risk / removable) for
 * `docs/security/privilege-audit.md`. The audit FAILS only on REMOVABLE
 * high-risk usage — e.g. eval, raw HTTP clients, runtime child_process, or
 * approval/sandbox/credential bypass intent in feature code. Documentation and
 * defensive deny-lists are classified as benign.
 *
 * @module dsh-evolve/audit/privilege
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditCheck } from './contracts.js'

export interface PrivilegeFinding {
  file: string
  line: number
  pattern: string
  snippet: string
  why: string
  capability: string
  risk: 'low' | 'medium' | 'high'
  removable: boolean
}

interface PatternDef {
  pattern: RegExp
  why: string
  capability: string
  risk: 'low' | 'medium' | 'high'
  removable: boolean
  /** Only scan files under these path prefixes (relative, posix). */
  include?: string[]
}

const REL = (root: string, file: string): string => file.replaceAll('\\', '/').replace(root.replaceAll('\\', '/'), '')

/** Directories that legitimately mention security terms (defensive code). */
const EXCLUDED_PREFIXES = ['src/audit', 'src/security', 'src/permissions']

const PATTERNS: PatternDef[] = [
  { pattern: /\bprocess\.env\b/, why: 'resolve DSH_HOME / evolve root from environment', capability: 'read environment', risk: 'low', removable: false },
  { pattern: /\bhomedir\(\)/, why: 'resolve ~/.dsh default store root', capability: 'read user home path', risk: 'low', removable: false },
  { pattern: /\bfetch\(/, why: 'single unified network client (src/network/client.ts)', capability: 'network egress (allowlisted)', risk: 'medium', removable: false },
  { pattern: /\bwriteFile\b|\bappendFile\b|\bmkdir\b|\brename\b|\brm\(|\bunlink\b/, why: 'evolve store writes under ~/.dsh/evolve/** (audited separately)', capability: 'write evolve store', risk: 'medium', removable: false },
  { pattern: /cordis\.patch/, why: 'plugin bundle patch (declarative config only)', capability: 'bundle install', risk: 'medium', removable: false },
  // Runtime child_process would be high-risk; offline eval launcher is allowed.
  { pattern: /\bchild_process\b|\bspawn\(|\bexec\(/, why: 'offline eval launcher spawns `dsh` only (src/offline/**); runtime must never spawn', capability: 'spawn dsh CLI (offline only)', risk: 'high', removable: true },
  { pattern: /\beval\(|\bFunction\(/, why: 'dynamic code execution — must never exist', capability: 'none', risk: 'high', removable: true },
  { pattern: /\bhttp\.request\b|\bhttps\.request\b|\bWebSocket\b|\bnet\.connect\b/, why: 'raw network clients — all egress must go through src/network/client.ts', capability: 'none', risk: 'high', removable: true },
  { pattern: /\bchmod\b|\bchown\b/, why: 'permission mutation — must never exist', capability: 'none', risk: 'high', removable: true },
  // Bypass intent in feature code (defensive modules excluded above).
  { pattern: /(?:disable|bypass|turn\s*off|skip|override)[^;\n]*(?:approval|sandbox|security\s*policy)/i, why: 'approval/sandbox bypass intent — evolve never disables DSH security', capability: 'none', risk: 'high', removable: true },
  { pattern: /(?:read|cat|open|get|obtain|access)[^;\n]*(?:credential|~\/\.ssh|~\/\.aws)/i, why: 'credential access — evolve never reads credentials', capability: 'none', risk: 'high', removable: true },
]

async function listTsFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'tasks' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.ts')) out.push(path)
    }
  }
  await walk(root)
  return out
}

function excluded(relative: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix =>
    relative.startsWith(prefix) || relative.startsWith(`/${prefix}`),
  )
}

/** Scan the repo for high-privilege API usage (classified findings). */
export async function scanPrivileges(repoRoot: string): Promise<PrivilegeFinding[]> {
  const files = await listTsFiles(repoRoot)
  const findings: PrivilegeFinding[] = []
  for (const file of files) {
    const relative = REL(repoRoot, file)
    if (!relative.startsWith('/src/') && !relative.startsWith('src/')) continue // src only
    if (excluded(relative)) continue
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n')
    for (const def of PATTERNS) {
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (line !== undefined && def.pattern.test(line)) {
          // Offline spawn is the documented exception.
          const offlineSpawn = def.pattern.source.includes('spawn') && relative.includes('/offline/')
          if (offlineSpawn) {
            findings.push({
              file: relative,
              line: index + 1,
              pattern: 'spawn(',
              snippet: line.trim().slice(0, 120),
              why: 'offline eval launcher spawns the dsh CLI (never at runtime)',
              capability: 'spawn dsh CLI (offline only)',
              risk: 'medium',
              removable: false,
            })
            continue
          }
          findings.push({
            file: relative,
            line: index + 1,
            pattern: def.pattern.source,
            snippet: line.trim().slice(0, 120),
            why: def.why,
            capability: def.capability,
            risk: def.risk,
            removable: def.removable,
          })
        }
      }
    }
  }
  return findings
}

/** Run the privilege audit check. */
export async function auditPrivilege(repoRoot: string): Promise<AuditCheck> {
  const findings = await scanPrivileges(repoRoot)
  const removableHighRisk = findings.filter(finding => finding.removable && finding.risk === 'high')
  const pass = removableHighRisk.length === 0
  return {
    id: 'privilege',
    name: 'Privilege audit (least privilege)',
    scope: 'security',
    verdict: pass ? 'PASS' : 'FAIL',
    detail: pass
      ? `${findings.length} classified usage(s); no removable high-risk usage`
      : `${removableHighRisk.length} removable high-risk usage(s): ${removableHighRisk.map(f => `${f.file}:${f.line}`).join(', ')}`,
    evidence: { total: findings.length, findings: findings.slice(0, 200) },
  }
}
