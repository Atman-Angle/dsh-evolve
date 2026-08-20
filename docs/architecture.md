# dsh-evolve 架构设计（v0.1）

> 定位：**Evidence-driven runtime optimization for DeepSeek Harness** —— 把执行轨迹变成可测试的运行时策略。
> 核心边界：**DeepSeek Harness 负责执行，dsh-evolve 负责基于执行轨迹进行优化。** 插件旁挂，不接管；插件移除后 DSH 恢复原始行为。
> 前置阅读：`docs/dsh-runtime-analysis.md`（源码证据）。

---

## 1. 设计原则（来自需求 §二）

1. **标准 DSH/Cordis 插件**：以 bundle（`dsh.bundle.patch` → cordis.patch.yml）或 profile 依赖 + patch 行的形式安装；配置行级启用/禁用；无 monkey patch；无源码修改。
2. **不替换官方 Agent Loop**：v0.1 只观察 + 注入，loop 原样运行。
3. **Runtime 热路径极轻**：无 LLM 调用、无 embedding、无向量检索、无每-step 数据库查询、无完整 session 重分析、无在线策略搜索。只做 `collect → normalize → incremental update → deterministic detection → apply approved policy → record`。
4. **不是新的 Runtime Authority**：Session/Agent/Tool/Context/LLM/Sandbox/Lifecycle 全部归 DSH；dsh-evolve 只有 Optimization Policy / Trajectory Analysis / Experiment Results / Intervention Decision。
5. **双平面**：Runtime Plugin（轻、在线、安装在 DSH 内）与 Offline Lab（重、离线、分析+实验）。两者通过 **Policy Recipe** 与 **轨迹数据** 交互。
6. **污染最小化**：不向 DSH durable Session 写插件自有状态（唯一例外是模型可见的策略重置消息，走 Core 词汇 `user/message` / `agent/inbox/spliced`）。

---

## 2. 双平面总图

```text
                        dsh-evolve

         ┌──────────────────┴──────────────────┐
         ↓                                     ↓

   Runtime Plugin（安装在 DSH 内）        Offline Lab（独立进程/脚本）
   ───────────────────────────         ───────────────────────────
   Observe（tools/result, session/event）   Read trajectories（session JSONL）
   ↓                                      ↓
   Extract incremental features         Analyze（replay-style stuck 打分）
   ↓                                      ↓
   Detect stuck（StuckScore ≥ 阈值）       Tune / Sweep 参数（可选 v0.2）
   ↓                                      ↓
   Apply active policy（STRATEGY_RESET）   Run Eval（baseline vs treatment）
   ↓                                      ↓
   Record intervention evidence          Compare recipes → Promote/Reject
   ↓                                      ↓
   └───────────────┬──────────────────────┘
                   ↓
            Policy Recipe（versioned JSON）
            ~/.dsh/evolve/policies/{baseline.json, reset-v1.json, …}
```

交互契约：
- **Runtime → 数据**：每次干预写 `InterventionRecord`；每个 session 结束时写一条 `RunSummary`（见 §5.4）。分析用**原始 session 日志**（DSH 持久化，`~/.dsh/sessions/...`）随时可读，不依赖插件状态。
- **Offline → Runtime**：只通过 recipe。Runtime 永不自行修改配置；recipe 由人（v0.1）或 Optimizer（v0.2）生成，经 eval 后 promote。

---

## 3. Runtime Plugin 模块与文件树

按需求 §二十四的建议结构精简（去掉 eval/ 与 offline/——它们属于 Offline Lab 平面）：

```text
dsh-evolve/            （npm 包：@dsh-evolve/plugin，或独立 scoped 包）
├ package.json          dsh: { bundle: { patch: ./cordis.patch.yml } }
│                       peerDeps: @deepseek-ai/cordis, @deepseek-ai/dsh-agent,
│                       @deepseek-ai/dsh-session, @deepseek-ai/dsh-llm, @deepseek-ai/dsh-tools
├ cordis.patch.yml      插入插件行：dsh-evolve（detector+intervention+storage）+ 每-agent preset 钩子（可选）
├ src/
│  ├ plugin/
│  │  ├ index.ts        插件入口：name/inject/Config/apply；组合各模块
│  │  └ lifecycle.ts    生命周期编排：注册/清理所有 listener/timer/service/状态
│  ├ collector/
│  │  └ trajectory-collector.ts   监听 session/event + tools/result，维护每-agent 增量轨迹
│  ├ features/
│  │  ├ feature-extractor.ts      由增量轨迹推进 TrajectoryFeatures（窗口 ring buffer）
│  │  ├ invocation-normalizer.ts  tool name + canonical args → 调用 key（deep key-sort JSON，参考 repeat-tool-reminder 实现）
│  │  ├ error-normalizer.ts       tool + exit-code-等价物(code) + 标准化错误文本 → 错误 signature
│  │  └ observation-fingerprint.ts tool/result content → 低成本哈希指纹（xxhash/fnv 风格，禁止 embedding）
│  ├ detector/
│  │  ├ stuck-detector.ts        窗口内特征 → 各信号计数/比例
│  │  └ stuck-score.ts           StuckScore 加权求值（recipe 参数驱动）
│  ├ intervention/
│  │  ├ controller.ts            cooldown/maxPerTurn/maxPerSession 门禁 + InterventionRecord 落盘
│  │  └ strategy-reset.ts        STRATEGY_RESET 消息构造（createUserMessage + plugin source）
│  ├ policy/
│  │  ├ recipe.ts                PolicyRecipe 类型 + 校验
│  │  ├ loader.ts                从 ~/.dsh/evolve/policies/ 读 active recipe（或 workspace 覆盖）
│  │  └ registry.ts              active recipe 解析/缓存/热重载（版本校验）
│  ├ storage/
│  │  ├ evolve-store.ts          ~/.dsh/evolve/{runs,policies,reports} 读写（JSONLines/JSON，原子写）
│  │  └ interleaved.ts           InterventionRecord / RunSummary 序列化
│  └ contracts/
│     ├ trajectory.ts  features.ts  intervention.ts   （类型 + 版本化 schema）
├ docs/  recipes/  tests/  reports/
```

依赖注入（`inject`）：`agents`（必）、`sessions`（观察）、`sessionPersistence`（可选，定位 session 工件）。不依赖 `agent-loop` 具体实现（官方约定：扩展插件依赖 `agent`，不依赖 `agent-loop`，见 `docs/subsystems/core.md:20`）。

---

## 4. Trajectory Evidence 清单（正式参考）

见 `docs/dsh-runtime-analysis.md` §1——此处只列 v0.1 实际消费的字段与信号对应：

| 证据 | 来源事件（持久/实时） | 信号 |
|---|---|---|
| 工具名 + 原始参数 | `tool/call`（持久） | B 重复调用 |
| 工具成败 | `tool/result.message[0].isError`（持久）；`tools/result` result（实时） | A 连续失败 |
| 结构化错误 | `tool/result.error.{name,code}` + `message` 文本 | C 重复错误 signature |
| 结果内容 | `tool/result.message.content`（文本块） | D 无新观察（指纹） |
| 是否写完/编辑类工具成功 | `tool/call.name` + `tool/result.isError`（持久）；`fs/observed`（实时可选） | E 工作区进展（`stepsSinceWorkspaceChange`） |
| Step/轮次计数 | `step/start`、`step/end`（持久） | `totalSteps`、窗口边界 |
| 人类干预 | `user/message.source.kind==='user'`（持久） | 重置窗口（防止跨干预计数） |
| Turn 结局 | `turn/end.reason`（持久） | eval 结果标签 |

约束：**不为了填特征而伪造数据**——无法可靠获得的字段（如 `exitCode`、`cacheReadTokens` 若 provider 不报）一律 optional 并用 recipe 开关门控。

---

## 5. Stuck 信号与打分（v0.1）

### 5.1 接口

```ts
interface TrajectoryFeatures {
  totalSteps: number                      // 自插件观察起（或 recipe 定义的重置点）累计 step
  consecutiveToolFailures: number         // 连续失败步数（A）
  repeatedToolRuns: number                // 当前最长的"同名同参连续调用"run 长度（B）
  repeatedErrorSignatureRuns: number      // 当前最长的"同 error signature 连续"run 长度（C）
  noNovelObservationSteps: number         // 距上一个"新观察"的步数（D，窗口内计数）
  stepsSinceWorkspaceChange?: number      // 距上一个"工作区变更"的步数（E，可选，默认关）
}

interface StuckReason { signal: 'consecutive-failures'|'repeated-actions'|'repeated-errors'|'no-novel-observation'|'no-workspace-change'; count: number }
```

窗口语义：`windowSize` 的滑动窗口（默认 6）。每个信号只统计窗口内的 run/计数；run 在收到"非同一 key 的调用"或"用户消息"时重置（与 repeat-tool-reminder 的 chain 语义一致，但更宽：错误 signature 与观察指纹也各自成链）。

### 5.2 信号定义（全部确定性、可离线复算）

- **A. consecutiveToolFailures**：连续 step 中，一个或多个 `tool/result.isError` 且无成功 mutation 的步数。单次失败不算 stuck。
- **B. repeatedToolRuns**：对 `(toolName, canonicalArgsHash)` 做 canonicalization（deep key-sort JSON → 哈希），窗口内最长连续相同 key 的调用数。**关键防误判**：B 只在与"该次调用前后无状态变化"联合时计分——实现上把 B 与 D/E 捆绑：若窗口内存在新观察或工作区变更，B 的贡献按 discount 衰减（recipe 参数 `repeatedActions.noveltyDiscount`，默认 0.5）。这样"改代码→测试→再改→测试"的循环不会被误伤。
- **C. repeatedErrorSignatureRuns**：`(toolName, error.code, normalizedErrorTextHash)` 的标准签名；窗口内最长连续相同签名的调用数。MODULE_NOT_FOUND ×3 比"连续失败 ×3"强得多。
- **D. noNovelObservationSteps**：每个 `tool/result` 的 content 做**低成本指纹**（规范化文本 → 稳定哈希，如 FNV-1a 64 位或 sha256 前缀）；"新观察" = 指纹与窗口内前 N 个不同。连续无新观察的步数。prune 掉纯噪声差异（recipe 参数：忽略长度 < L 的微小文本差异为"不新"）。
- **E. stepsSinceWorkspaceChange**（默认关）：持久等价物 = "自上次成功的 mutation 类工具调用（recipe 配置的名单，如 write/edit/apply_patch/bash 执行成功）的步数"；在线增强 = `fs/observed`。实测证明可靠后再默认开启。

### 5.3 StuckScore

```text
stuckScore(step) =
    wA · fA(consecutiveFailures)      // fA = min(1, consecutiveFailures / thresholdA)
  + wB · fB(repeatedRuns)             // fB = min(1, repeatedRuns / thresholdB) · noveltyDiscount
  + wC · fC(repeatedErrorRuns)        // fC = min(1, repeatedErrorRuns / thresholdC)
  + wD · fD(noNovelSteps)             // fD = min(1, noNovelSteps / thresholdD)
  + wE · fE(stepsSinceChange)         // fE = min(1, stepsSinceChange / thresholdE)，默认关闭
触发条件：stuckScore ≥ triggerScore 且最近 X 步内未触发（见 §6 cooldown）
```

初始参数（`recipes/reset-v1.json`，全部可被 recipe/Offline sweep 覆盖）：

```yaml
detector:
  windowSize: 6
  consecutiveFailures: { threshold: 3, weight: 0.35 }
  repeatedActions:    { threshold: 3, weight: 0.25, noveltyDiscount: 0.5 }
  repeatedErrors:     { threshold: 2, weight: 0.25 }
  noNovelObservation: { threshold: 4, weight: 0.15 }
  workspaceChange:    { enabled: false, threshold: 5, weight: 0.15 }
  triggerScore: 0.65
```

> 这些参数是**初始实验值**，不是结论。Offline Analyzer 的职责之一就是在真实轨迹上扫描这些参数的 precision/recall（Q1）。

### 5.4 证据记录

每次触发（无论是否真正注入）都记录：

```ts
interface InterventionRecord {
  sessionId: string
  step: number
  turn: number
  score: number
  reasons: StuckReason[]
  policyId: string
  policyVersion: string
  injected: boolean            // false = 达到 cooldown/cap 而记录但未注入
  timestamp: number            // epoch ms
}
```

每个运行结束（`turn/end` 全部收敛 + agent 静止，或在 Offline 从日志重建）写：

```ts
interface RunSummary {           // 供 Offline Lab 关联
  sessionId: string
  taskId?: string
  policyId?: string
  steps: number; toolCalls: number
  inputTokens?: number; outputTokens?: number   // 从 assistant/message.usage 聚合
  durationMs: number                              // session 创建→最后事件
  stuckEvents: number; interventions: number; injections: number
  ended: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'interrupted' | 'user-stop'
}
```

---

## 6. Intervention（只实现 STRATEGY_RESET）

### 6.1 注入机制（官方 seam，见 runtime-analysis §2.2/§5）

```ts
const message = createUserMessage({
  content: [{ type: 'text', text: STRATEGY_RESET_TEXT }],
  source: { kind: 'plugin', plugin: 'dsh-evolve', form: 'notice', summary: 'strategy reset: stuck trajectory detected' },
})
switch (injectionPoint) {
  case 'step-end':  agent.inject(message); break   // 工具循环中 stuck（主路径）
  case 'turn-stopping': agent.steer(message); break // 模型提前停止（辅助路径）
}
```

- **step-end 注入（v0.1 唯一活跃路径）**：在 `session/event`（step/end）同步监听器内完成，`agent.inject(message)`。时序已被 agent-loop 循环结构保证（见 runtime-analysis §2.3）：注入后 inbox 非空，循环继续下一 step。
- **turn-stopping 为去重守卫（v0.1 语义）**：step-end 已处理当前 step 时，turn-stopping 到来即为 no-op（`lastHandledGlobalStep` 去重），不重复记录、不 steer。原因：凡是 step-end 曾注入的 step，inbox 已非空，loop 根本不会进入 turn-stopping；未注入（预算/cooldown）的 step 在 turn-stopping 也应遵守相同门禁，因此该 seam 在 v0.1 实际不产生新注入——留作未来"模型提前停止"干预的接口位。
- **cooldown 时钟**：使用单调的全局 step 计数（`extractor.stepCount`，跨 turn 递增），而非 turn 内 step 号（DSH 的 step 号每 turn 从 1 重新计数）。

### 6.2 消息模板（recipe 可配，领域无关）

```text
The current execution trajectory appears to be producing little new progress.

Do not continue the same approach automatically.

Before taking the next action:
1. summarize only the concrete facts established so far,
2. identify the assumption or strategy that has failed,
3. explicitly abandon that approach,
4. choose a materially different next strategy,
5. continue execution.

Do not repeat previous tool calls unless the environment or relevant state has changed.
```

要求：**strategy reset ≠ domain-specific instruction**；不改任务目标；只打断低收益轨迹。

### 6.3 门禁（防干预死循环）

```yaml
intervention:
  cooldownSteps: 5      # 距上次注入 >= 5 步才允许再次注入
  maxPerTurn: 1         # 每个 turn 至多注入 1 次
  maxPerSession: 3      # 每个 session 至多注入 3 次
```

超限行为：**继续检测与记录**（stuckEvents 继续累计），但不再注入。v0.1 不自动升级为其他策略。`maxPerSession` 计数随 `agent/inbox/spliced`（dsh-evolve 源消息）在恢复时重建（从 `user/message.source.plugin==='dsh-evolve'` 计数），实现持久一致。

### 6.4 边界（v0.1 明确不做）

`model escalation / fork / subagent / tool restriction / context compaction / human escalation / automatic stop` 一律不进 v0.1；只留类型与接口位（`InterventionType = 'strategy-reset'`，未来扩展在 recipe 层面演进）。

---

## 7. Runtime Overhead 分析

目标：**每 step 增量 O(1)～O(windowSize)，不随 Session 长度恶化**。

| 环节 | 复杂度 | 说明 |
|---|---|---|
| 观察（session/event / tools/result 同步回调） | O(1) | 仅拷贝必要字段（key/hash/flag），不深拷贝大 payload |
| 指纹计算 | O(|content|) 一次 | 内容哈希仅对"工具结果文本"做一次，不 embedding |
| 增量特征推进 | O(1) 均摊 | ring buffer（定长 windowSize）滚动；过期槽位直接覆盖 |
| StuckScore | O(窗口) = O(windowSize) | 触发判定只遍历固定窗口 |
| 注入 | O(1) + 一次消息构造 | 受 recipe/cooldown 门禁；注入本身一次 `createUserMessage` |
| 持久化（InterventionRecord） | 罕见 | 仅在触发时写一行 JSONL（原子 append） |

总量：每个 step 常数级（几十微秒量级），且**无任何网络/模型/DB/向量开销**。内存：每 agent 一个固定大小窗口对象，`agent/disposed` 即释放。禁止的热路径操作清单见需求 §三.3，本设计逐条承诺不执行。

---

## 8. Persistence 与卸载安全

### 8.1 插件自有存储

```text
~/.dsh/evolve/
  policies/   active.json(软链或内容) + baseline.json + reset-v1.json …
  runs/       <sessionId>.json         （RunSummary）
  evals/      <taskId>/<runId>.jsonl   （eval 过程数据，Offline 平面写）
  reports/    latest.md 等
```

或 workspace-local `.dsh/evolve/`（recipe `storage.root` 可配：`harness-home`（默认）| `workspace`）。写入全部原子（临时文件 + rename），损坏自愈（目录缺失视为空库）。

### 8.2 与 DSH Session 的关系

- **不写**任何插件私有事件进 Session（见 runtime-analysis §6）。
- 唯一进入 Session 的产物是策略重置 `user/message`（Core 词汇）——它**提高**而非降低会话可读性（模型可见内容有完整记录）。
- 卸载插件：`dsh plugin --profile <n> remove @dsh-evolve/plugin` → bundle 行移出层叠；Cordis 卸载该插件的所有 effect（listener/timer/service/agent 内存状态全部回收）。**已有 Session 的原样读取/续跑不受影响**（无新事件类型、无 schema 变化）。
- 插件数据与学习数据的生命周期分离：卸载 = 停止优化，不删除 `~/.dsh/evolve/`；重新启用重新读取（no data loss）。用户可自行删除目录。

---

## 9. 插件生命周期（Cordis）

- 所有注册走 `ctx.on` / `ctx.effect`（返回 disposer）；`apply(ctx, config)` 组合所有模块；`AgentRegistry` 类注册全部清理。
- 每个 agent 的可变状态放进 `WeakMap<Agent, State>` 并在 `agent/disposed` 监听器中清理（或随 scope 卸载一并回收）；**插件 dispose 后：无 listener、无残留干预、无 monkey patch、无全局状态**。
- 作用域选择：插件默认装在 root context（服务 `ctx.evolve` 可选）；干预/检测按 `agent` 级状态隔离；与 DSH 官方多 agent（含 subagent）语义兼容（默认只干预 root，recipe 可配 `scope`）。
- 热重载（HMR/Include refresh）期间：effect 卸载→重建，状态重建从 `session.events` 尾部增量恢复（窗口从 `firstLiveSeq` 起重放一次，成本 O(窗口) 量级，可接受；默认不重放历史也可以，只丢窗口前信号）。

---

## 10. Offline Lab（v0.1 最小形态）

命令（包内 bin：`dsh-evolve`，包装在 DSH 之外独立运行，**不加载 DSH**）：

```text
dsh-evolve analyze <sessionId> [--recipe reset-v1.json]
    # replay-style：读 ~/.dsh/sessions/<project>/<id>/session.* → Session.create + fold
    # 每 step 打印 stuck score / 信号明细 / 若启用该 recipe 会在哪些 step TRIGGER
    # 不调用模型；只回答"这个 policy 会在哪里触发"，不回答"触发后会不会变好"

dsh-evolve eval --tasks tasks.yaml --profile-name eval-baseline|eval-treat [--runs N] ...
    # 编排：profile 层 + --patch overlay → dsh --profile <n> "task prompt" ×N
    # 收集 sessionID → grader（确定性命令/断言）→ metrics → reports/latest.md
```

Analyzer 与检测器**共用同一套特征/打分代码路径**（离线对同一窗口语义逐事件复算），保证"运行时触发 == 离线可复现触发"（这是 Q1 可信度的基础）。

---

## 11. Policy Recipe（契约）

```ts
interface PolicyRecipe {
  id: string                 // 'baseline' | 'reset-v1'
  version: string            // semver-ish
  detector: DetectorConfig   // §5.3
  intervention: {
    type: 'strategy-reset'
    messageTemplate?: string // 默认 §6.2 文案
    cooldownSteps: number
    maxPerTurn: number
    maxPerSession: number
  }
  metadata?: { createdAt?: string; sourceExperiment?: string; compatibleDshVersion?: string }
}
```

加载：`~/.dsh/evolve/policies/active.json` → 校验 schema → 失败则回退 `baseline.json`（baseline = 只观察不注入，是所有实验的对照组 recipe）。Runtime 只执行 active recipe，绝不自行改写。

---

## 12. 与 DSH 已有相近实现的边界（Q: 是否重复）

| DSH 已有 | 做什么 | dsh-evolve 差异 | 关系 |
|---|---|---|---|
| `repeat-tool-reminder`（base bundle 默认挂载） | 仅"同名同参连续调用"一信号，阈值 [3,5,8]，注入**轻提醒**（"analyze before repeat"），不评分、无兜底/上限、无 recipe、无 eval | 多信号融合打分、窗口化、cooldown/cap、全链路 recipe + 实验、干预为**策略重置**（明确要求放弃旧策略换新策略，而非提醒） | 不重复；**实验须隔离**（两臂都显式禁用该插件，见 experiment-design §3.4） |
| `timeout-policy` | 工具超时包装（TOOL_TIMEOUT） | 无关（不同层） | 无冲突 |
| goal / Ralph | 外层轮转/续跑策略；**明确没有** stuck detection / no-progress 启发 | 目标不同：我们检测"轨迹浪费"并做一次策略重置 | 可协作：reset 可作为 goal round 的"干预动作"（v0.2 之后） |
| compaction | 上下文压力处理 | 信号面不同（token 压力 vs 行为停滞） | 可协作 |

**结论：不存在必须停止开发的高度重复项目。** dsh-evolve 的差异点（确定性多信号 StuckScore + 可实验的 recipe 体系 + 离线 analyze/eval 工具链 + 诚实报告）是 DSH 生态中缺失的部分。