/**
 * Network audit (v0.2 release hardening, spec §十).
 *
 * Verifies:
 *   - the ONLY global-fetch site is src/network/client.ts;
 *   - no raw http/https/WebSocket/net clients exist elsewhere;
 *   - the default allowlist denies non-Commons hosts;
 *   - offline spawn of the dsh CLI is the only child_process use.
 *
 * @module dsh-evolve/audit/network
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditCheck } from './contracts.js'
import { isAllowedUrl } from '../network/allowlist.js'

export interface NetworkSite {
  file: string
  line: number
  api: string
  allowed: boolean
  reason: string
}

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

const EGRESS_APIS: ReadonlyArray<{ api: string; re: RegExp; allowed: (relative: string) => boolean; reason: string }> = [
  { api: 'fetch(', re: /\bfetch\(/, allowed: relative => relative.includes('/network/client.ts'), reason: 'unified network client only' },
  { api: 'http.request/https.request/WebSocket/net.connect', re: /\b(?:http|https)\.request\b|\bWebSocket\b|\bnet\.connect\b/, allowed: () => false, reason: 'raw network clients never used' },
  { api: 'spawn/exec', re: /\b(?:spawn|exec)\(/, allowed: relative => relative.includes('/offline/'), reason: 'offline dsh launcher only' },
]

/** Inventory egress sites and verify each is allowed. */
export async function inventoryNetworkSites(repoRoot: string): Promise<NetworkSite[]> {
  const files = await listTsFiles(repoRoot)
  const sites: NetworkSite[] = []
  for (const file of files) {
    const relative = file.replaceAll('\\', '/').replace(repoRoot.replaceAll('\\', '/').replace(/\/+$/, ''), '')
    if (!relative.startsWith('/src/') && !relative.startsWith('src/')) continue
    // Defensive modules contain detector patterns (regex strings), not egress.
    if (relative.includes('/audit/') || relative.includes('/security/')) continue
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n')
    for (const def of EGRESS_APIS) {
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (line !== undefined && def.re.test(line)) {
          sites.push({
            file: relative,
            line: index + 1,
            api: def.api,
            allowed: def.allowed(relative),
            reason: def.reason,
          })
        }
      }
    }
  }
  return sites
}

/** Run the network audit check. */
export async function auditNetwork(repoRoot: string): Promise<AuditCheck> {
  const sites = await inventoryNetworkSites(repoRoot)
  const violations = sites.filter(site => !site.allowed)
  // Allowlist spot checks.
  const allowlistOk = !isAllowedUrl('https://evil.example.com/exfil').allowed
    && isAllowedUrl('https://raw.githubusercontent.com/dsh-evolve/commons/main/registry/index.json').allowed
  const pass = violations.length === 0 && allowlistOk
  return {
    id: 'network',
    name: 'Network egress (allowlist + single adapter)',
    scope: 'security',
    verdict: pass ? 'PASS' : 'FAIL',
    detail: `${sites.length} egress site(s); ${violations.length} violation(s); allowlist check ${allowlistOk ? 'ok' : 'FAILED'}`,
    evidence: { sites: sites.slice(0, 100), violations: violations.slice(0, 50) },
  }
}
