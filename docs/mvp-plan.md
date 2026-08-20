# dsh-evolve MVP 实施计划（v0.1）

> 范围：只做 Stuck Detection（A–E 五信号）+ STRATEGY_RESET 干预 + 离线 analyze + 对照 Eval。
> 顺序原则：先让"观察→特征→检测→记录"闭环可测，再接干预；先离线验证触发点，再开在线干预。

---

## P0 — 工程脚手架（半天级）

- npm 包骨架（`@dsh-evolve/plugin`，对 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools` 为 peerDeps/optionalDeps）+ `cordis.patch.yml`（插件行 + 配置）。
- `recipes/baseline.json`、`recipes/reset-v1.json`（默认参数版）。
- 最小可加载插件：`apply(ctx)` 空实现 + 生命周期测试（mount/unmount 无泄漏）。
- 验证：本地 dev DSH 树（`D:\deepseek-harness` 工作区，`pnpm dsh --profile ... --patch`）确认行插入与卸载对账。

## P1 — 观察与特征（核心，先做）

模块：`collector/`、`features/`、`contracts/`。

- `trajectory-collector`：`session/event` 监听（session scope）增量维护每 agent 轨迹；`tools/result` 热路径快照。
- `feature-extractor`：五类信号推进（§architecture 5）；窗口 ring buffer；`agent/disposed` 清理；用户消息重置窗口。
- `observation-fingerprint`：FNV-1a/sha256 前缀指纹 + 规范文本裁剪；单测先行。
- `invocation-normalizer` / `error-normalizer`：deep key-sort canonical args（复用 repeat-tool-reminder 的 proven 实现思路）；error signature = tool+code+归一化文本。
- 测试：以真实 session JSONL 为 fixture 的"重放一致性"测试（运行时算出的特征 == 离线重放算出的特征）。

## P2 — 检测与记录（离线先行）

模块：`detector/`、`storage/`、`policy/`。

- `stuck-detector`/`stuck-score`：完全确定、纯函数、无 IO —— 与 DSH 解耦。
- `evolve-store`：`~/.dsh/evolve/` 原子写；`InterventionRecord`/`RunSummary` 序列化。
- **离线 analyzer**（`dsh-evolve analyze`）：读 `~/.dsh/sessions/**/session.*`（JSONL/zst 解码，复用 DSH 的 session 读取边界——直接依赖 `@deepseek-ai/dsh-session` 的 `Session.create` + `KNOWN_SESSION_EVENT_TYPES` 校验，避免复制解码器）；逐 step 复算并打印。
- 验收：对一个"人工构造 + 真实失败"的 fixture session，analyze 输出与手算一致。

## P3 — 干预（最晚开）

模块：`intervention/`。

- `strategy-reset` 消息构造 + `controller`（cooldownSteps/maxPerTurn/maxPerSession 门禁，记录 injected=false 的 stuck 事件）。
- 两条注入线：step/end（`session/event` 同步）与 turn-stopping（serial listener + steer）。
- `agent/pre-step` 额外挂"用户消息检测"重置窗口；与 repeat-tool-reminder 的复位规则一致。
- 测试：headless 假 adapter 场景（不发工具调用直接结束 / 连续失败 / 重复调用）验证：触发步、注入一次、cooldown 生效、cap 后只记录。
- **三态验证**：安装 → 跑任务的注入轨迹；卸载 → `dsh plugin remove`；重装 → 状态重建；原 session 续跑不受影响。

## P4 — Eval 与报告闭环

模块（Offline Lab）：`eval/`（runner + grader + metrics + comparison）。

- task fixture 仓库（20–50 个任务）+ grader（命令/断言）。
- eval runner：profile 编排 + 并行受限运行 + 结果落盘 + crash/超时容错。
- `reports/latest.md` 生成（§experiment-design 5）+ 四类案例抽取。
- 分析脚本：Q1 precision/recall 曲线（对历史轨迹扫描 triggerScore 与各阈值）、Q2 recovery、Q3 配对检验、Q4 成本。

---

## 测试策略

| 层 | 覆盖 | 工具 |
|---|---|---|
| 单元 | 信号推进/指纹/canonicalize/打分/门禁 | vitest（纯函数，无 DSH 依赖） |
| 集成 | 真实 `@deepseek-ai/cordis` + dsh-agent/session 的最小组合：注入路径、时序、scope | vitest + DSH workspace dev |
| 重放一致性 | runtime 特征 == 离线重放特征（关键不变量） | fixture session JSONL |
| 端到端（keyless） | headless + 可控 adapter（脚本化响应）回放典型 stuck 轨迹，断言干预发生且次数受控 | 参照 DSH 仓库播种的 snapshot 思路 |
| 实验（with key） | 对照实验运行；此层消耗 API 预算，独立开关 | `dsh-evolve eval` |

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 注入时机竞态/turn-stopping 误触发 | P3 集成测试钉死时序；step/end 注入为主路径；turn-stopping 只在 score 高且窗口内未注入时用 |
| 检测信号在真实任务上噪声大 | P2 先用 analyze 在 5–10 条真实轨迹上标定，再冻结 reset-v1 参数；Q1 必须报 precision/recall |
| eval 成本（token/time） | fixture 预装依赖、复用 workspace 缓存；每任务 3 次起步、按预算上限控制；token 预算写入任务约束 |
| repeat-tool-reminder 混杂 | 两臂显式禁用；记录在案（experiment-design §3.4） |
| DSH 上游 API 演进 | 只依赖文档化事件/接口（contracts/ 单独一包，便于跟随上游漂移）；版本记录 `compatibleDshVersion` |

---

## 里程碑

1. **M1**：P0–P2 完成——plugin 可装可卸、analyzer 可离线打分（无干预）。✔（含 wiring 集成的卸载安全测试）
2. **M2**：P3 完成——干预闭环（step-end 注入 + 门禁 + 记录）已验证（cordis 集成测试钉死时序/次数）；turn-stopping 语义收敛为去重守卫（见 architecture §6.1）。✔
   **真实 DSH profile 装载验证（本轮完成）**：用隔离 `DSH_HOME` + 官方 `dsh plugin --profile` 初始化 scratch profile，bundle 经 `node_modules` 解析、patch `insert:` 层正确应用、`--dump-config` 组合树包含 `dsh-evolve` 行（recipe: reset-v1）。首次 boot 暴露并修复两个真实缺陷：① patch 必须用 `insert:` 形式；② 带 config 的行要求插件导出 **schemastery Config schema**（普通对象会让 loader 报 `Config['~standard'].validate` 错误）。还尝试了**无 key 完整启动**：用 DSH 自带 `llm-mock-server`（本地脚本化 LLM）+ profile 补丁显式配置 `llm-deepseek.baseURL` → 模型层可到达（mock 收到过真实请求），但本沙箱内 DSH 启动存在**非确定性早期挂起**（对照实验：禁用本插件后同样挂起；挂起点不定且零 CPU，疑似沙箱对 loader/工具管线某些 IO 的阻塞）。结论：组合树 + loader 级验证已闭环；完整 headless boot 与 `dsh plugin add` 三态验证需在真实机器上完成（代码与步骤已就绪）。
3. **M3**：P4 完成——第一批对照实验结果 + `reports/latest.md`。（代码骨架已完成，实时运行需任务集与 API key）
4. **判定门**：Q3 无显著改善 => 停止扩展，转向参数扫描/信号调整并把负结果写进报告；有改善 => 才考虑 v0.2（recipe 参数搜索）。

## 交付物清单

### 第一轮（设计，已完成）

- [x] `docs/dsh-runtime-analysis.md` —— 源码/API/风险分析（7 问）
- [x] `docs/architecture.md` —— 双平面架构、evidence 清单、信号定义、overhead、持久化/卸载安全、生命周期、与已有实现边界
- [x] `docs/experiment-design.md` —— Q1–Q4 实验设计、分组隔离、度量、报告规则、统计
- [x] `docs/mvp-plan.md` —— 本文件（P0–P4 + 验收）
- [x] `recipes/baseline.json`、`recipes/reset-v1.json` —— 初始候选 recipe
- [x] `README.md` —— 定位与 A–E 结论

### 实现（P0–P3 已完成，已验证）

- [x] `src/` —— plugin（apply/lifecycle + Cordis 接线）、collector（DSH `session/event` → 规范化轨迹）、features（fingerprint/canonicalize/error-signature/novelty）、detector（窗口特征 + StuckScore）、intervention（controller 门禁 + strategy-reset 消息）、policy（recipe 校验/内置 recipe）、storage（`~/.dsh/evolve/` 原子串行写）
- [x] `src/offline/` —— `dsh-evolve analyze <sessionId>` CLI：离线读取 session 工件（raw/zstd，`node:zlib` 原生 zstd），与运行时共用同一特征/打分代码，逐 step 输出 score/TRIGGER/reasons（规格格式）；support `--file/--root/--recipe/--json`
- [x] `cordis.patch.yml` —— bundle 安装层（插件行 + `recipe: reset-v1` 默认）
- [x] 测试：**70/70 通过**（9 个 spec：hash/normalizers/feature-extractor/stuck-score/recipe/evolve-store/replay-consistency/wiring(cordis 集成)/session-reader/offline-analyzer），连续多轮全量复跑稳定；`pnpm typecheck`、`pnpm build` 通过；CLI 端到端冒烟输出符合规格

### 剩余（P4 实时运行，需 API key 与真实 DSH 环境）

- [x] eval 代码骨架 + **Q2 recovery 评估**：`src/offline/eval/recovery.ts`（注入后窗口内出现新观察/成功变更或最终成功 ⇒ recovered，否则 falsePositive；纯函数，7 测试）+ runner 接入（treatment 臂读插件 store 的 InterventionRecord）+ `compareArms` 汇总
- [x] **Q1 参数扫描**：`src/offline/eval/sweep.ts` + `dsh-evolve sweep --root <sessions> [--scores 0.4,...]`——对轨迹语料按 triggerScore 网格输出 **precision/recall/FPR/TP/FP/FN/TN**（bad outcome = turn/end 非 completed）；CLI 端到端冒烟通过，与单元测试数值一致
- [x] **3 个真实任务 fixture**：`tasks/{parser-fix-01, string-escape-fix-02, dead-code-refactor-03}/`（workspace + prompt.md + 确定性 grader `node check.js`），真实子进程端到端测试（坏代码 fail / 修复 pass），`tasks/README.md` 任务规范
- [x] CLI `dsh-evolve eval --dry-run` 用真实 `tasks/example.tasks.json` 冒烟通过
- [ ] tasks/ 扩充到 20–50 个真实 Long-Horizon 任务（按 tasks/README.md 规范）
- [ ] 真实 `dsh` profile 两臂运行（`--arm baseline|treatment` 各 ≥3 次/任务）→ 双臂合并比较 + 完整 `reports/latest.md`（含 recovered/falsePositives）
- [ ] Q1 在真实实验轨迹上出数、Q3 配对检验、Q4 成本，及"明显成功/失败/false positive/regression"案例