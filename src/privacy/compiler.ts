/**
 * Privacy Compiler (v0.2, spec §19).
 *
 * Pipeline: Canonicalization → PII Detection → Path/Repo/Org Removal →
 * Secret Scan → Free-text Reduction → Schema Compilation → Preview.
 *
 * The compiler NEVER silently scrubs: if a PII or secret hit is found, the
 * capsule is rejected with the hit reported. A rejected capsule is safe; a
 * leaked capsule is not.
 *
 * @module dsh-evolve/privacy/compiler
 */

import { ALLOWED_ACTIONS, isAllowedAction } from '../contracts/actions.js'
import type {
  CorrectionPayload,
  ExperienceRecord,
  FactPayload,
  FailurePatternPayload,
  ProcedurePayload,
} from '../experience/contracts.js'
import { scanObjectPii, type PiiHit } from './pii-filter.js'
import { scanObjectSecrets, type SecretHit } from './secret-filter.js'
import { capsuleHash, outcomeDirection, supportBucket, type ExperienceCapsule } from './capsule.js'

export interface CompileResult {
  ok: boolean
  capsule?: ExperienceCapsule
  /** Why compilation failed (privacy rejection reasons). */
  errors: string[]
  piiHits: PiiHit[]
  secretHits: SecretHit[]
}

/** Kinds that may never enter the Commons (spec §5 Target 2). */
const NEVER_SHAREABLE: ReadonlySet<string> = new Set(['preference'])

/** Map a fact subject to a schema-defined action (spec §16 enums). */
export function actionForFact(fact: FactPayload): string | undefined {
  if (fact.subject === 'package-manager') return 'USE_DETECTED_PACKAGE_MANAGER'
  if (fact.subject === 'test-command') return 'PREFER_TARGETED_TEST'
  return undefined
}

/** Whether a correction's args indicate a package-manager switch. */
const PM_ARGS = /(npm|pnpm|yarn|bun)\s+(install|add|ci|i)\b/

function correctionAction(corr: CorrectionPayload): string | undefined {
  return PM_ARGS.test(corr.failed.args) || PM_ARGS.test(corr.succeeded.args)
    ? 'USE_DETECTED_PACKAGE_MANAGER'
    : undefined
}

/** Build the structured capsule body for an experience (no free text yet). */
function buildCapsuleBody(record: ExperienceRecord): { kind: ExperienceCapsule['kind']; trigger: Record<string, unknown>; recommendedAction?: string; summary: string } {
  switch (record.kind) {
    case 'fact': {
      const fact = record.payload as FactPayload
      const action = actionForFact(fact)
      return {
        kind: 'fact',
        trigger: { subject: fact.subject, property: fact.property, value: fact.value, scope: fact.scope },
        ...(action === undefined ? {} : { recommendedAction: action }),
        summary: `${fact.subject}.${fact.property} detected (${fact.scope})`,
      }
    }
    case 'correction': {
      const corr = record.payload as CorrectionPayload
      const action = correctionAction(corr)
      return {
        kind: 'correction',
        trigger: {
          failed: { tool: corr.failed.tool, actionKey: corr.failed.actionKey },
          succeeded: { tool: corr.succeeded.tool, actionKey: corr.succeeded.actionKey },
          failureKeys: corr.failureKeys,
        },
        ...(action === undefined ? {} : { recommendedAction: action }),
        summary: `correction: ${corr.failed.tool} → ${corr.succeeded.tool}`,
      }
    }
    case 'successful-procedure': {
      const proc = record.payload as ProcedurePayload
      return {
        kind: 'procedural',
        trigger: { tools: [...new Set(proc.steps.map(step => step.tool))], steps: proc.steps.length },
        summary: `procedure: ${[...new Set(proc.steps.map(step => step.tool))].join(' → ')}`,
      }
    }
    case 'failure-pattern': {
      const pattern = record.payload as FailurePatternPayload
      return {
        kind: 'failure-pattern',
        trigger: { kind: pattern.kind, repeats: pattern.repeats, signature: pattern.signature },
        ...(pattern.recommendedAction !== undefined && isAllowedAction(pattern.recommendedAction)
          ? { recommendedAction: pattern.recommendedAction }
          : {}),
        summary: `${pattern.kind} (x${pattern.repeats})`,
      }
    }
    case 'preference':
      throw new Error('preference experiences are never shareable')
  }
}

/**
 * Compile one private experience into a shareable capsule. Rejects (with
 * reasons) when the experience kind is not shareable or any PII/secret hit is
 * found in the generated content.
 */
export function compileExperience(record: ExperienceRecord, now = new Date().toISOString()): CompileResult {
  const errors: string[] = []
  if (NEVER_SHAREABLE.has(record.kind)) {
    errors.push(`kind ${record.kind} is never shareable`)
    return { ok: false, errors, piiHits: [], secretHits: [] }
  }
  let body
  try {
    body = buildCapsuleBody(record)
  } catch (error) {
    errors.push((error as Error).message)
    return { ok: false, errors, piiHits: [], secretHits: [] }
  }

  const draft = {
    schema: 'evolve/v1' as const,
    kind: body.kind,
    appliesTo: { ...record.compatibility.task },
    trigger: body.trigger,
    ...(body.recommendedAction === undefined ? {} : { recommendedAction: body.recommendedAction }),
    evidence: {
      supportBucket: supportBucket(record.evidence.occurrences),
      outcomeDirection: outcomeDirection(record.evidence.successfulOccurrences, record.evidence.failedOccurrences),
    },
    privacy: { rawSession: false as const, freeText: false as const },
    summary: body.summary,
    sourceExperienceId: record.id,
    createdAt: now,
  }

  // Privacy validation over the ENTIRE generated content (fail loud).
  const piiHits = scanObjectPii(draft)
  const secretHits = scanObjectSecrets(draft)
  if (piiHits.length > 0) {
    errors.push(`PII hit(s): ${piiHits.map(hit => `${hit.kind}(${hit.match})`).join(', ')}`)
  }
  if (secretHits.length > 0) {
    errors.push(`secret hit(s): ${secretHits.map(hit => `${hit.kind}(${hit.match})`).join(', ')}`)
  }
  if (errors.length > 0) return { ok: false, errors, piiHits, secretHits }

  const capsule: ExperienceCapsule = { ...draft, hash: capsuleHash(draft) }
  return { ok: true, capsule, errors, piiHits, secretHits }
}

/** Compile several experiences; returns the successful capsules and failures. */
export function compileMany(
  records: readonly ExperienceRecord[],
  now = new Date().toISOString(),
): { capsules: ExperienceCapsule[]; failures: Array<{ id: string; errors: string[] }> } {
  const capsules: ExperienceCapsule[] = []
  const failures: Array<{ id: string; errors: string[] }> = []
  for (const record of records) {
    const result = compileExperience(record, now)
    if (result.ok && result.capsule !== undefined) capsules.push(result.capsule)
    else failures.push({ id: record.id, errors: result.errors })
  }
  return { capsules, failures }
}

export { ALLOWED_ACTIONS }
