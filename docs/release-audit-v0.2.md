# dsh-evolve Release Audit — v0.2 (release-hardening round)

> Answers to the nine release-gate questions (spec §二十七). Evidence comes
> from `pnpm test` (218 tests incl. `tests/audit/**`), `pnpm typecheck`,
> `pnpm build`, and `dsh-evolve audit --all` (reports/audit/latest.md).
> Generated: 2025 (this round).

---

## Q1 — 安装 dsh-evolve 后，在没有 ACTIVE Mutation 时，是否会改变原 DSH 的 Model / Tool trajectory？

**No.** Deterministic evidence: `tests/audit/non-interference.spec.ts`
(`src/audit/non-interference.ts`) runs one deterministic DSH fixture three ways
and asserts the derived trajectory metrics are byte-identical:

```text
A. Vanilla DSH (events as ground truth)
B. DSH + dsh-evolve, observation only
C. DSH + dsh-evolve, full background evolution (real queue + worker), no ACTIVE mutation

compared: event count, tool call count, tool names, tool arguments, tool results,
turns, steps, session completion → A == B == C (PASS)
```

The durable session event log IS the trajectory, and the plugin never writes
to it (v0.1 guarantee, re-verified here). Observation is read-only; the only
model-visible output evolve can produce is an explicitly approved mutation
(injection of an ACTIVE skill / policy).

## Q2 — dsh-evolve 是否会阻塞正常 DSH 执行？

**No.** The runtime hot path is O(1) per event:

```text
event capture → cheap normalization → bounded buffer → queue enqueue
```

No LLM, no embedding, no session rescan, no eval, no GitHub, no privacy
analysis, no skill generation on the step path. Background work runs only at
session-settled / idle / maintenance / manual, through a bounded persistent
queue (max 200 jobs, max 3 attempts, drop-lowest when full). The benchmark
(`benchmarks/runtime-overhead.ts`, `dsh-evolve benchmark`) measures 1k/10k/100k
events and reports per-event overhead + p95 + queue growth:
`reports/audit/runtime-overhead.md` (PASS: bounded, no linear scans, queue ≤ 200).

## Q3 — 后台自进化是否会额外消耗主 Agent 的模型额度？

**No by default.**

```text
foreground        → zero model usage (pure deterministic observers)
background        → deterministic mining/planning/privacy (zero model usage)
semantic miner    → DEFAULT OFF (spec §十九); when enabled: background-only,
                    concurrency 1, max pending jobs 10
quota breaker     → 429/quota/timeout trips the semantic-miner breaker
                    (pauseMinutes 30); never steals the main agent's quota
```

The semantic (model-based) miner is not implemented as an automatic runtime
feature in this round; the deterministic miner needs no provider at all.

## Q4 — 什么时候会询问用户？

By evolution mode (default `balanced`):

| Risk | Examples | Action |
|---|---|---|
| 0 | workspace memory facts | silent auto |
| 1 | preference, skill routing | auto + visible in status |
| 2 | workflow recipe | shadow → auto after local evidence |
| 3 | skill create/update | **ask once** (`[Activate] [Ignore] [Review]`) |
| 4 | context/tool policy | validate + **ask** |
| 5 | runtime policy | evidence + eval + shadow + **ask by default** |
| 6 | generated code / plugin | never automatic; manual review only |

Users are NOT spammed per experience: risk 0–2 are silent; only high-impact
mutations (risk ≥ 3) produce a single notification. `dsh-evolve status` shows
`pending approval` count.

## Q5 — Evolve 自己崩溃以后 DSH 能否继续运行？

**Yes — proven by failure injection** (`tests/audit/failure-isolation.spec.ts`):

```text
injected: miner crash, privacy compiler crash, semantic provider unavailable,
store write failure, GitHub 500 + timeout + 429, invalid capsule + tampered
manifest, corrupt local queue state

asserted every time: agent task completes; session log intact; no inject/steer;
diagnostic recorded; breaker pauses the affected capability
```

All 7 scenarios PASS. The plugin's own observers are wrapped in try/catch and
the background worker never lets an exception escape to the agent path.

## Q6 — 卸载插件后 DSH 是否完全恢复？

**Yes.** Verified by the lifecycle audit (`tests/audit/lifecycle-supply-skill.spec.ts`):

```text
50+ load/dispose cycles → no lingering listeners (post-dispose emission is
inert), no timer residue, worker stopped, queue released
uninstall → a fresh DSH session loads, runs, and stays fully readable
```

The plugin keeps no global state and requires no evolve state for DSH to work
(evolve state lives only under `~/.dsh/evolve/**`; deleting it never affects DSH).

## Q7 — 插件到底拥有哪些权限？

See `docs/security/privilege-audit.md` (source-level, every high-privilege
usage classified: why / required capability / risk / removable). Summary:

```text
read environment       → $DSH_HOME resolution (low, required)
read user home         → default store root (low, required)
network egress         → allowlisted GitHub Commons via ONE adapter (medium)
write filesystem       → ~/.dsh/evolve/** only, traversal-blocked (medium)
spawn child process    → OFFLINE eval launcher only (`dsh` CLI), never at runtime
zero usage of          → eval / Function / raw http clients / chmod / credentials
                         / approval bypass / sandbox modification (verified by scan)
```

Removable high-risk findings: **0** (audit PASS).

## Q8 — 恶意 Commons / Skill 是否可以影响 Agent？

**No.** Supply-chain adversarial tests (`tests/audit/lifecycle-supply-skill.spec.ts`,
`src/audit/supply-chain.ts`, `src/audit/skill-security.ts`):

```text
malicious manifest/capsule content — shell, exec, eval, Function,
system_instruction, prompt injection, http_request, file://, path traversal,
symlink, unexpected binary, unknown executable action, unsupported schema
version, invalid hash, tampered manifest
→ REJECTED at verification/quarantine (schema + prohibited fields + suspicious
  values + hash); never reaches SHADOW/ACTIVE/agent context

malicious skills — read ~/.ssh, read credentials, disable approval, upload
secrets, curl exfiltration, base64 commands, ignore instructions, modify
security config
→ scanner flags CRITICAL and blocks activation; downloaded skills have ZERO
  capabilities; agent reads only skills/active/
```

Semantic scanner helps detection; the harness (sandbox, tool policy, approval,
capability scope) remains the enforcement authority (spec §18).

## Q9 — Raw Session 是否可能离开设备？

**No. Default answer, no exceptions in v0.2.**

```text
L0 raw session (prompts, outputs, tool results, paths, code) is written only
to DSH's own durable log and dsh-evolve's local observer buffers — both local.
Capsules (the only traveling artifact) are compiled from STRUCTURED experience
payloads (tool names + hash signatures + counts); free text is dropped by
canonicalization, and the privacy compiler FAIL-LOUD rejects any PII/secret/
path/repo content instead of scrubbing it (verified by the privacy adversarial
audit + `tests/audit/privacy-adversarial.spec.ts`).
Contribution is opt-in (default disabled) and manual; auto-contribute is
restricted to structured kinds with min support and no free text.
```

---

## Release gate

```text
pnpm typecheck              PASS
pnpm build                  PASS
pnpm test                   PASS (218 tests)
dsh-evolve audit --all      PASS (10/10 checks, reports/audit/latest.md)
```

Known risks (documented, not release-blocking):

- Plugins run in-process: only install trusted plugins (see security-model.md).
- Semantic mining is deterministic-only in this round; a future model-based
  miner must stay background-only behind its quota circuit breaker.
- The stuck-reset recipe (`reset-v1`) is a pre-existing ACTIVE v0.1 runtime
  policy; it only fires on deterministic stuck trajectories and is separately
  eval-gated (Runtime Evolution Example #1).
