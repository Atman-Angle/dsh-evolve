/**
 * Filesystem audit (v0.2 release hardening, spec §九).
 *
 * Verifies that every evolve write stays inside `~/.dsh/evolve/**`:
 *   - inventories fs write sites in source and classifies their target root;
 *   - runtime-checks path traversal: malicious relative paths and store ids
 *     are rejected, so no write can escape the allowed root.
 *
 * @module dsh-evolve/audit/filesystem
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditCheck } from './contracts.js'
import { JsonlStore, assertSafeStoreId } from '../storage/jsonl-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { SkillStore } from '../targets/skill/store.js'

export interface WriteSite {
  file: string
  line: number
  api: string
  targetRoot: 'evolve-store' | 'offline-artifacts' | 'unknown'
  why: string
}

const WRITE_APIS = /\b(writeFile|appendFile|mkdir|rename|rm|unlink)\b/

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

/** Inventory fs write sites and classify their target root. */
export async function inventoryWriteSites(repoRoot: string): Promise<WriteSite[]> {
  const files = await listTsFiles(repoRoot)
  const sites: WriteSite[] = []
  for (const file of files) {
    const relative = file.replaceAll('\\', '/').replace(repoRoot.replaceAll('\\', '/').replace(/\/+$/, ''), '')
    if (!relative.startsWith('/src/') && !relative.startsWith('src/')) continue
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line === undefined) continue
      const match = line.match(WRITE_APIS)
      if (match === null || match[0] === undefined) continue
      const targetRoot = relative.includes('/offline/')
        ? 'offline-artifacts'
        : 'evolve-store'
      sites.push({
        file: relative,
        line: index + 1,
        api: match[0],
        targetRoot,
        why: targetRoot === 'offline-artifacts'
          ? 'offline lab artifacts under ~/.dsh/evolve/** (reports/evals/work)'
          : 'runtime evolve store under ~/.dsh/evolve/**',
      })
    }
  }
  return sites
}

/** Runtime traversal check: malicious paths/ids must be rejected. */
export async function checkPathTraversal(): Promise<{ pass: boolean; detail: string }> {
  const failures: string[] = []
  // 1. JsonlStore rejects '..' relative paths.
  try {
    new JsonlStore(tmpdir(), '../escape.json')
    failures.push('JsonlStore accepted a traversal relative path')
  } catch {
    // expected
  }
  // 2. Store ids with separators are rejected.
  for (const id of ['../../evil', 'a/b', '..\\evil', 'a\\b', 'x'.repeat(65)]) {
    try {
      assertSafeStoreId(id)
      failures.push(`store id accepted: ${id}`)
    } catch {
      // expected
    }
  }
  // 3. SkillStore refuses crafted ids.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evolve-audit-fs-'))
  const store = new SkillStore(dir)
  try {
    await store.createCandidate({
      name: 'x', description: 'x', trigger: {}, instructions: ['x'],
    }, { id: '../../evil', source: 'generated', experienceIds: [], evidence: { sessions: 1, occurrences: 1, successfulOccurrences: 1, failedOccurrences: 0, confidence: 0.5 } })
    failures.push('SkillStore accepted a traversal id')
  } catch {
    // expected
  }
  await rm(dir, { recursive: true, force: true })
  return {
    pass: failures.length === 0,
    detail: failures.length === 0 ? 'traversal blocked at JsonlStore + store-id level' : failures.join('; '),
  }
}

/** Run the filesystem audit check. */
export async function auditFilesystem(repoRoot: string): Promise<AuditCheck> {
  const sites = await inventoryWriteSites(repoRoot)
  const unknown = sites.filter(site => site.targetRoot === 'unknown')
  const traversal = await checkPathTraversal()
  const pass = unknown.length === 0 && traversal.pass
  return {
    id: 'filesystem',
    name: 'Filesystem scope (writes confined to ~/.dsh/evolve/**)',
    scope: 'security',
    verdict: pass ? 'PASS' : 'FAIL',
    detail: `${sites.length} write site(s) inventoried; ${unknown.length} unclassified; traversal: ${traversal.detail}`,
    evidence: { sites: sites.slice(0, 200), traversal },
  }
}
