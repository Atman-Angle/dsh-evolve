# dsh-evolve Spec v0.2 — Implementation Reference

> Status: implemented in `src/` per this document. v0.1 (stuck-reset) is preserved
> and re-positioned as **Runtime Evolution Example #1** (`Evolution Targets → Runtime
> Policy → stuck-reset`).
>
> Companion docs: `docs/architecture.md` (v0.1 dual-plane architecture),
> `docs/experiment-design.md`, `docs/mvp-plan.md`.

---

## 0. 项目定位

`dsh-evolve` 是一个可插拔的 DeepSeek Harness 自进化插件。

- 不修改 DSH Core，不替换默认 Agent Loop，不训练基础模型参数。
- 通过长期观察用户真实 Session，把执行记录转化为**可验证的 Experience**，
  再根据 Experience 对九个层级（Memory / Profile / Skill 创建 / Skill 优化 /
  Skill Routing / Workflow Recipe / Context Policy / Tool Policy / Runtime Policy）
  提出 **Mutation**，经 **Validation** 后 **Promote**。

```text
Use → Observe → Extract Experience → Propose Mutation → Validate → Promote → Future Run → New Evidence → Continue Evolving
```

**核心原则**：

> Raw Session belongs to the user.
> Experiences may travel; conversations should not.
> Community knowledge may be downloaded automatically, but remote content is never automatically trusted.

**定位**：evidence-driven experience evolution，不是 autonomous self-modifying runtime。

---

## 1. 非目标（明确不做）

- 基础模型训练 / LoRA / Fine-tuning / 在线 RL
- 自动修改 DeepSeek Harness Core
- 无边界自动生成并执行代码；v0.2 不实现自动 Plugin Generation
- 自动安装未知第三方插件
- 上传完整 Session / Prompt / 项目代码 / 原始 Tool Result / Secret
- 中央化用户行为数据收集；自建云端 SaaS 后端
- 未验证经验直接影响 Agent；社区 Prompt 直接进入 System Prompt

---

## 2. 核心抽象

```text
Experience → Mutation → Evidence
```

- **Experience**：从一次或多次真实执行中提炼出的规律（不能直接修改系统）。
- **Mutation**：基于 Experience 建议修改哪个可进化对象（必须携带 Evidence）。
- **Evidence**：任何 Mutation 必须携带的量化依据
  (`sessions / occurrences / successful / failed / confidence`，未来扩展
  eval result、token/latency delta、regression rate、model compatibility、DSH version)。

---

## 3. 数据层级

| 层级 | 内容 | 规则 |
|---|---|---|
| L0 Raw Session | Prompt、Output、Request、Context、Tool Call/Result、文件路径、源码、错误日志、环境状态、凭据相关元数据 | 默认永久只存在用户本地；公共协议不得要求上传；Commons 不接受 L0 |
| L1 Private Experience | 本地提炼经验（可能含项目/组织/流程信息） | 默认 Local-only |
| L2 Shareable Capsule | 经 Privacy Compiler 转化的结构化经验 | 去路径/repo/用户名/组织/源码/Prompt/原始输出/Secret/可识别实体；才允许贡献 |
| L3 Community Experience | 经 Schema/Privacy/Security 验证 + 独立支持 + 社区评审 + Release 验证的公共经验 | 只是 Candidate prior，不是本地最终真理 |

---

## 4. 可进化对象与风险模型

| Target | riskLevel | 自动化权限 | v0.2 实现 |
|---|---|---|---|
| Memory | 0 | 可自动 | `src/targets/memory/` |
| Preference | 1 | 自动 + 可查看 | `src/targets/profile/` |
| Skill routing | 1 | 自动 + 可查看 | `src/targets/skill-routing/` |
| Recipe | 2 | Shadow 后自动 | `src/targets/recipe/` |
| Skill update / create | 3 | 默认需要确认 | `src/targets/skill/` |
| Context / Tool Policy | 4 | Eval 后 Promote | `src/targets/policy/` |
| Runtime Policy | 5 | Eval + Shadow + rollback | `src/targets/policy/`（含 stuck-reset） |
| Generated Code / Plugin | 6 | 人工审核 | v0.2 不实现 |

每个可进化对象的状态机：`DISCOVERED → CANDIDATE → VALIDATING → ACTIVE → DEPRECATED → REJECTED`。
Skill 对象另有安全状态机：`AVAILABLE → DOWNLOADED → QUARANTINED → STATIC_SCAN → SEMANTIC_REVIEW → LOCAL_TEST → CANDIDATE → USER/POLICY APPROVAL → ACTIVE`。

所有 ACTIVE Mutation 必须可回答：为什么启用、来自什么 Experience、何时启用、效果如何、当前版本、如何回滚。

---

## 5. Experience Types（五种基础）

| Kind | 形式 | 来源 |
|---|---|---|
| `fact` | `A is true in this workspace` | 确定性探测器（包管理器、测试命令、运行时、数据库） |
| `preference` | `User repeatedly prefers X over Y` | 长期行为统计（回答长度、先分析再编码等） |
| `correction` | `A → failure/correction → B → success` | 失败后用户纠正且纠正后成功 |
| `successful-procedure` | `A → B → C → success` 且失败 Session 缺该模式 | 多个成功 Session 的重复步骤序列 |
| `failure-pattern` | `A → A → A → no progress` | 重复错误/重复动作/无进展 |

---

## 6. Experience Engine 流水线

```text
Session Events → Episode Extractor → Candidate Experience Miner → Normalizer
→ Deduplicator → Evidence Aggregator → Confidence Calculator → Experience Store
```

- **Episode Extractor** (`src/episode/`): 不把完整 Session 丢给分析器，先切成
  Task-level Episode（Task Begin / Tool sequence / Correction / Error /
  User intervention / Skill activation / Validation / Completion）。
- **Miner** (`src/experience/miner.ts`): 两层。
  - Deterministic Miner：repeated tool sequence、same correction、skill usage、
    same error transition、tool → success pattern。低成本、纯函数、可离线重放。
  - Semantic Miner：离线模型分析（为什么纠正、哪些步骤构成可复用程序、两次行为是否同经验），
    **禁止放在实时 Agent hot path**（v0.2 提供接口与文档，不自动执行）。
- **Normalizer**：候选经验规范化为稳定 `summaryKey`（去噪、截断、结构化）。
- **Deduplicator**：同 `summaryKey` 跨 Session 聚合（计数、会话合并、首见/最后更新）。
- **Confidence**：`confidence = successRate × support × sessionFactor`（见 `src/experience/confidence.ts`）。

---

## 7. Mutation Planner 与 Registry

```ts
interface MutationProposal {
  id: string
  sourceExperienceIds: string[]
  target: 'memory' | 'profile' | 'skill-create' | 'skill-update' | 'skill-routing'
        | 'recipe' | 'context-policy' | 'tool-policy' | 'runtime-policy'
  riskLevel: number
  proposedChange: unknown
  evidence: EvidenceSummary
  status: MutationStatus
  validation?: ValidationResult
  version: number
  createdAt: string
}
```

- `planner.ts`：Experience → Proposal 的确定性映射（含阈值与证据门槛）。
- `registry.ts`：Proposal 生命周期持久化，记录来源经验、启用时间、版本、回滚方式。
- `risk.ts`：风险分级与 `requiredGate(risk)`：
  `auto | auto-visible | shadow | confirm | eval | eval-shadow-rollback | human-review`。

---

## 8. Validation Engine

- **Static**：schema/结构验证（`security/schema-validator.ts`）。
- **Replay**：对历史 Session 重放候选变更，统计 would-have 行为（`validation/replay.ts`）。
- **Shadow**：候选匹配任务时计算「如果启用会怎么做」，不真正改变 Agent，记录 Outcome
  （`validation/shadow.ts`）。
- **Deterministic Eval**：证据阈值、回归检查、A/B 统计（复用 v0.1 eval 工具链，`validation/evaluator.ts`）。
- **Promotion**：按风险门槛决定 CANDIDATE → ACTIVE（`validation/promotion.ts`）。

---

## 9. Privacy Compiler 与 Capsule

```text
Private Experience → Canonicalization → PII Detection → Path Removal
→ Repo/Org Removal → Secret Scan → Free-text Reduction → Schema Compilation → Preview
```

- 第一阶段：用户确认后上传；未来允许低风险 Capsule 自动贡献（默认关闭）。
- L2 Capsule（`evolve/v1`）只允许 schema-defined actions：
  `USE_DETECTED_PACKAGE_MANAGER | PREFER_TARGETED_TEST | STRATEGY_RESET | REDUCE_TOOL_SURFACE
  | EXPAND_TOOL_SURFACE | COMPACT_OLD_TOOL_RESULTS | MODEL_ESCALATE`。
- 禁止 `shell/exec/eval/http_request: arbitrary-url/prompt: free-text/system_instruction`。

---

## 10. GitHub Commons（无服务器）

`github.com/dsh-evolve/commons`：

```text
schema/evolve-v1.schema.json        experiences/{coding,research,general}/
policies/{context,tools,runtime}/   recipes/        registry/index.json
benchmarks/                         security/prohibited-fields.json + policy.json
.github/workflows/{validate,security,build-registry,release}.yml
```

- Commons 仅存声明式数据；第一阶段 PR 禁止 `.js/.ts/.py/.sh/.exe/.dll/binary`。
- 本地 Registry 状态：`AVAILABLE → DOWNLOADED → SHADOW → ACTIVE | REJECTED`；
  自动同步只允许 `AVAILABLE → DOWNLOADED`。
- 同步周期：`startup | daily | 6h | manual | disabled`。
- Contribution Policy 默认 `enabled: false, mode: manual`，必须 opt-in。

---

## 11. Skill Distribution Security

社区 Skill 与 Experience Commons 分离。公共 Skill：**可以自动下载，不能自动激活**。
正常 Agent Context 只能读取 `skills/active/`，不能读取 `downloaded/`、`quarantine/`。

> Semantic Scanner helps detection. Harness authority enforces security.

---

## 12. 本地存储布局（`<DSH_HOME>/evolve/` 下扩展）

```text
experiences/   experiences.jsonl  (ExperienceRecord)
mutations/     proposals.jsonl    (MutationProposal + 状态历史)
memory/        facts.jsonl
profile/       preferences.jsonl
skills/        active/<id>.json   skills.jsonl (索引 + 版本历史)
routing/       routing.jsonl
recipes/       workflow/*.json    (WorkflowRecipe)
policies/      context/ tool/ runtime/ (Policy 对象；active.json 为 v0.1 兼容)
commons/       cache/ registry.jsonl manifest.json
capsules/      capsules.jsonl (已编译的 L2 Capsule + 预览)
runs/ evals/ reports/ work/       (v0.1 保留)
```

全部写入原子化（temp + rename）、串行化（与 v0.1 `EvolveStore` 同模式）。

---

## 13. CLI（`dsh-evolve <command>`）

```text
analyze | eval | sweep | report        (v0.1 保留)
experience mine|list|detail            (Experience Engine)
mutations propose|list|promote|reject|deprecate|rollback
skills list|create|candidate|activate|deactivate|rollback|import
memory list | profile list
recipe list|propose
capsule compile|preview|list
sync [--interval] [--force]            (Commons sync)
contribute [--dry-run]                 (Privacy → PR 准备)
status                                 (总览)
```

---

## 14. 开发阶段映射（Phase 1–8 → 代码）

| Phase | 内容 | 代码 |
|---|---|---|
| 0 | 冻结 v0.1 stuck-reset | 保留，仅重定位 |
| 1 | Personal Experience Engine（Fact/Correction/Procedure/FailurePattern） | `episode/` + `experience/` |
| 2 | Skill Evolution（第一条完整飞轮：多 Session → 候选 Skill → 确认 → v1 → 使用 → v2） | `targets/skill/` + `targets/skill-routing/` |
| 3 | Mutation Framework（Memory/Profile/Routing/Recipe） | `mutation/` + `targets/{memory,profile,recipe}` |
| 4 | Harness Evolution（Context/Tool/Runtime Policy，Eval 驱动） | `targets/policy/` + `validation/` |
| 5 | Experience Capsule（隐私编译 + 泄漏测试） | `privacy/` |
| 6 | GitHub Commons（manifest/sync/verify/contribute） | `commons/` |
| 7 | Skill Security（下载→隔离→扫描→测试→激活，绝不自动激活） | `security/` |
| 8 | Collective Flywheel（本地结果 → 社区证据更新 → 新 Capsule） | `commons/` + CLI |

---

## 15. 成功指标与 MVP

- **Personal Evolution**：repeated mistake rate ↓、skill reuse rate ↑、correction frequency ↓、
  task success ↑、manual intervention ↓、token/steps ↓。
- **Collective Evolution**：adoption、local validation pass rate、regression rate、
  privacy/security rejection rate、跨用户 reuse。
- **MVP（最重要里程碑）**：3 个 Session 重复同一纠正 → 检测出重复纠正 →
  生成候选 Skill → 用户接受 → 第 4 个 Session Skill 自动匹配 → 避免旧错误 → 记录结果。
  实现为 `tests/evolution-flywheel.spec.ts`（纯逻辑闭环）。
