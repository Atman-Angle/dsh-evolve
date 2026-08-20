# dsh-evolve Release Audit

generated: 2026-08-19T07:41:58.212Z
plugin: 0.1.0 dsh: 0.1.0-rc.5 node: v24.11.1 platform: win32/x64

| check | verdict | detail |
|---|---|---|
| Privilege audit (least privilege) | PASS | 61 classified usage(s); no removable high-risk usage |
| Filesystem scope (writes confined to ~/.dsh/evolve/**) | PASS | 77 write site(s) inventoried; 0 unclassified; traversal: traversal blocked at JsonlStore + store-id level |
| Network egress (allowlist + single adapter) | PASS | 4 egress site(s); 0 violation(s); allowlist check ok |
| Commons supply-chain (malicious content rejected at verification) | PASS | 13/13 malicious fields rejected; sync kept nothing |
| Skill security (malicious skills blocked before activation) | PASS | 8/8 malicious skills flagged critical + blocked |
| Privacy adversarial (fail-loud, no L0 leakage) | PASS | 3 capsule(s) clean, 1 fail-loud rejection(s) |
| Non-interference (A == B == C) | PASS | A == B == C (11 events, 2 tool calls, 2 steps, completed=true) |
| Failure isolation (agent survives injected failures) | PASS | 7 injected failure scenarios; agent task completed every time |
| Runtime overhead (per-event bounded) | PASS | 1000 events: evolve=5.8ms vanilla=0.09ms overhead≈1427ns/event p95=3100ns queue≤200; 10000 events: evolve=52.53ms vanilla=0.3ms overhead≈1306ns/event p95=2700ns queue≤200 |
| Lifecycle (30 load/dispose cycles + uninstall) | PASS | 30 load/dispose cycles clean; no listener or timer residue | uninstall: fresh DSH session loads and runs after uninstall |

**Release Audit: PASS**

