/**
 * Contribution pipeline (v0.2, spec §20, §30 — Collective Flywheel).
 *
 * Compiles local private experiences into shareable capsules and stages them
 * for a GitHub PR. Contribution is opt-in, manual by default; auto-contribute
 * is possible ONLY for low-risk structured kinds meeting strict requirements
 * (no free text, no raw session, minimum support). The git/PR mechanics are
 * performed by the CLI via the `git` binary; this module stages files and
 * produces the report + commit message.
 *
 * @module dsh-evolve/commons/contribution
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExperienceCapsule } from '../privacy/capsule.js'
import { renderCapsulePreview } from '../privacy/capsule.js'
import { validateFileType } from '../security/schema-validator.js'

export interface ContributionPolicy {
  enabled: boolean
  mode: 'manual'
  autoContribute: {
    enabled: boolean
    allowedKinds: string[]
    requirements: {
      freeText: false
      rawSession: false
      minSupport: number
    }
  }
}

export const DEFAULT_CONTRIBUTION_POLICY: ContributionPolicy = {
  enabled: false,
  mode: 'manual',
  autoContribute: {
    enabled: false,
    allowedKinds: ['runtime-statistic', 'structured-procedure'],
    requirements: { freeText: false, rawSession: false, minSupport: 10 },
  },
}

/** Whether a capsule may be auto-contributed under the policy. */
export function canAutoContribute(
  capsule: ExperienceCapsule,
  policy: ContributionPolicy = DEFAULT_CONTRIBUTION_POLICY,
): { allowed: boolean; reason?: string } {
  if (!policy.enabled) return { allowed: false, reason: 'contribution disabled' }
  if (!policy.autoContribute.enabled) return { allowed: false, reason: 'auto-contribute disabled' }
  if (!policy.autoContribute.allowedKinds.includes(capsule.kind)) {
    return { allowed: false, reason: `kind ${capsule.kind} not auto-contributable` }
  }
  const requirements = policy.autoContribute.requirements
  if (capsule.privacy.freeText !== requirements.freeText || capsule.privacy.rawSession !== requirements.rawSession) {
    return { allowed: false, reason: 'privacy requirements not met' }
  }
  const support = Number.parseInt(capsule.evidence.supportBucket.replace('+', ''), 10)
  if (!Number.isFinite(support) || support < requirements.minSupport) {
    return { allowed: false, reason: `support ${capsule.evidence.supportBucket} < minSupport ${requirements.minSupport}` }
  }
  return { allowed: true }
}

export interface ContributionBundle {
  release: string
  files: Array<{ path: string; content: string }>
  report: string
}

/** Common file-name for a capsule entry. */
export function capsuleFileName(capsule: ExperienceCapsule): string {
  return `${capsule.kind}-${capsule.hash.slice(0, 12)}.json`
}

/**
 * Stage capsules for contribution (writes files under
 * `<root>/commons/contribution/<release>/`).
 */
export async function prepareContribution(
  capsules: readonly ExperienceCapsule[],
  opts: { root: string; release?: string; now?: string },
): Promise<ContributionBundle> {
  const now = opts.now ?? new Date().toISOString()
  const release = opts.release ?? `capsules-${now.slice(0, 10)}`
  const baseDir = join(opts.root, 'commons', 'contribution', release)
  const files: Array<{ path: string; content: string }> = []

  for (const capsule of capsules) {
    const filename = capsuleFileName(capsule)
    const relative = join('experiences', capsule.kind, filename)
    const check = validateFileType(relative)
    if (!check.ok) throw new Error(`contribution rejected: ${check.reason}`)
    // Strip local traceability before staging (spec §24: not uploaded).
    const { sourceExperienceId: _local, hash, ...shareable } = capsule
    void _local
    const staged = JSON.stringify({ ...shareable, hash }, null, 2)
    const path = join(baseDir, relative)
    await mkdir(join(baseDir, 'experiences', capsule.kind), { recursive: true })
    await writeFile(path, `${staged}\n`, 'utf8')
    files.push({ path: relative, content: staged })
  }

  const report = [
    `# dsh-evolve contribution — ${release}`,
    '',
    `capsules: ${capsules.length}`,
    '',
    ...capsules.map(capsule => `## ${capsuleFileName(capsule)}\n\n${renderCapsulePreview(capsule)}\n`),
  ].join('\n')
  await writeFile(join(baseDir, 'REPORT.md'), report, 'utf8')
  return { release, files, report }
}

/** Standard commit message for a contribution. */
export function contributionCommitMessage(bundle: ContributionBundle): string {
  const kinds = new Set(bundle.files.map(file => file.path.split('/')[1]))
  return `docs(commons): add ${bundle.files.length} experience capsule(s) [${[...kinds].join(', ')}] (${bundle.release})`
}
