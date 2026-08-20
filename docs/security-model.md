# dsh-evolve Security Model (v0.2)

> Release hardening documentation. Companion to `docs/security/privilege-audit.md`
> (source-level privilege audit) and `docs/release-audit-v0.2.md` (release gate Q&A).

## Position

dsh-evolve is a **pluggable DeepSeek Harness plugin**. It is not a sandboxed
process and it is not a security boundary. **DeepSeek Harness plugins run
in-process, so users should only install trusted plugins.** dsh-evolve must
never be presented as a strongly-isolated sandboxed plugin.

## dsh-evolve can

```text
observe DSH runtime events            (session/event, agent events)
write its own local store             (~/.dsh/evolve/** only)
generate candidate evolution artifacts (experiences, candidate skills, proposals)
sync verified GitHub Commons data     (manifest + release assets, hash-verified)
ask the user before high-impact mutations (risk ≥ 3 by default)
run local audits and benchmarks       (dsh-evolve audit / benchmark)
```

## dsh-evolve does not

```text
read credentials                       (no credential access anywhere in src/)
bypass approval                        (approval stays fully with DSH)
disable the sandbox                    (never touches sandbox behavior)
silently install plugins               (plugin install is never automated)
execute community code                 (Commons is declarative-only; skills need approval + scanning)
upload raw sessions                    (L0 never leaves the device)
upload user prompts                    (capsules carry structured data only)
upload source code                     (capsules carry hash signatures only)
modify DSH Core                        (zero core patches; bundle patch is declarative config)
```

## Two-plane architecture

| Plane | Runs | Touches | Failure mode |
|---|---|---|---|
| Foreground Runtime Plane | on every session event | bounded observer state, queue enqueue | O(1)/event; failures logged, never block |
| Background Evolution Plane | session-settled / idle / maintenance / manual | mining, planning, privacy, commons sync | breaker pauses the capability + diagnostic; vanilla DSH continues |

**Invariant:** `dsh-evolve failure → evolution paused → vanilla DSH continues`.
The agent path never depends on evolve.

## Data tiers (privacy)

| Tier | Content | Travel |
|---|---|---|
| L0 Raw Session | prompts, outputs, tool results, paths, code | local only — never uploaded |
| L1 Private Experience | distilled local regularities | local only by default |
| L2 Shareable Capsule | structured, PII/secret-scanned | may be contributed (opt-in, manual by default) |
| L3 Community Prior | verified Commons data | downloadable; never auto-trusted |

## Network egress

All outbound traffic flows through the unified network client
(`src/network/client.ts`), which enforces:

```text
allowlist        → GitHub Commons hosts (+ optional configured semantic provider)
timeout          → 10s default
rate limit       → 60 req/min default
circuit breaker  → 3 failures → 30 min pause
audit log        → every request recorded in-memory
```

Feature modules (`experience/`, `skill/`, `privacy/`, `mutation/`) never call
`fetch` directly (verified by the network audit).

## Evolution permission model

| Risk | Target | Balanced mode | Autopilot |
|---|---|---|---|
| 0 | memory facts | auto | auto |
| 1 | preference / skill routing | auto + visible | auto |
| 2 | workflow recipe | shadow → auto | auto |
| 3 | skill create/update | **user approval** | validated auto (if enabled) |
| 4 | context/tool policy | validate + **user approval** | validated auto (if enabled) |
| 5 | runtime policy | validate + **user approval** | configurable |
| 6 | generated code / plugin | **never automatic** | **never automatic** |

Never automatic in ANY mode (enforced by the promotion gate):

```text
modify DSH sandbox
disable approval
obtain credentials
execute community code
install third-party plugins
expand system privileges
```

## Failure handling

Every background stage is wrapped:

```text
failure (crash / 429 / timeout / GitHub down / corrupt state)
  → circuit breaker trips the capability
  → diagnostic recorded (~/.dsh/evolve/diagnostics/)
  → queue caps retries (default 3)
  → DSH agent continues untouched
```

Commons sync is fully background: DSH boots from the stale verified cache (or
without Commons); it never waits for GitHub.

## Supply chain

- Commons PRs may only contain declarative data (`.json` / `.yml` / `.md`);
  executable file types are rejected.
- Downloaded entries are verified: content hash → evolve/v1 schema → PII/secret
  scan → suspicious-value scan (file://, path traversal, eval/Function markers,
  credential paths, binary blobs).
- Anything failing verification is REJECTED at download/quarantine; the local
  registry only ever moves `AVAILABLE → DOWNLOADED` automatically.
- Community skills follow `DOWNLOADED → QUARANTINED → STATIC_SCAN →
  SEMANTIC_REVIEW → LOCAL_TEST → CANDIDATE → APPROVAL → ACTIVE`; the agent
  context can only read `skills/active/`.

## Filesystem scope

Evolve writes are confined to `~/.dsh/evolve/**` (plus user-approved workspace
skill/config targets). Path traversal is blocked at the store layer (relative
paths with `..` rejected, store ids validated). Verified by the filesystem
audit.

## Verification

```text
pnpm typecheck
pnpm build
pnpm test          (218 tests incl. audit suites)
pnpm audit         (dsh-evolve audit --all → reports/audit/latest.md)
pnpm benchmark     (runtime overhead → reports/audit/runtime-overhead.md)
```
