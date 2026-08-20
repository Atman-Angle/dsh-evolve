# dsh-evolve — DeepSeek Harness Runtime / Plugin Seam 源码分析

> 状态：第一轮设计交付（v0.1 前置研究）。
> 范围：基于 `D:\deepseek-harness` 当前工作树源码的直接阅读（Append-A 列出全部证据位置）。
> 结论先行：**v0.1 可以完全是随插随拔的纯插件，零 Core 改动、零新 Session 事件类型**；干预注入走官方 steering/inbox seam，所有模型可见内容自动满足 "Model-visible ⟺ logged" 不变量；卸载后 DSH 会话保持有效。

---

## 0. 摘要

| # | 问题 | 结论 |
|---|---|---|
| 1 | 可获得哪些 trajectory evidence | 完整持久事件日志（turn/step 边界、user/assistant/tool 消息、token usage、错误、inbox splice）+ 实时事件（agent/*、tools/*、fs/observed）。详见 §1 清单 |
| 2 | 可用哪些公开扩展 seam | `session/event`（同步 emit，按 session scope）、`agent/*` 全族（pre-step / request / turn-stopping / status / error…）、`tools/result`（冻结结果的同步通知）、`agent.steer()/inject()` steering、`MessageSource` 的 `plugin` 源类型。详见 §2 |
| 3 | v0.1 能否保持纯插件 | **能**。全部观察与干预都在官方事件与 inbox API 之上，无需修改 agent-loop；官方仓库自己的 goal / workspace-context / repeat-tool-reminder 插件已经展示了完全相同的模式 |
| 4 | 什么运行时状态可安全观察 | 任何 `session/event`（持久、按 session 隔离）、`tools/result`（执行内、冻结结果）、`agent/status` 等。禁止触摸 loop 私有 phase、签名内部、`deriveMessages` 之外的任何来源 |
| 5 | strategy reset 如何注入 | `agent.inject()/steer()` + `{kind:'plugin'}` source 的 user 消息。两条时间线：step/end 注入（工具循环中 stuck）与 `agent/turn-stopping` steering（模型提前停止）。均为官方文档化 seam |
| 6 | 什么不应写入 DSH Session | 实验状态、Policy、得分明细、分析数据。模型可见的策略重置文本除外（它走 `user/message` + `agent/inbox/spliced` 两个 Core 词汇，属于官方设计内的"注入上下文"） |
| 7 | 兼容性风险 | 主要风险 = 向 Session 写未知事件类型（会让老版本拒绝加载）；本项目完全避免。其他风险清单见 §7 |

关键源码事实（详见附录）：
- **turn/step 驱动**：`packages/core/agent-loop/src/agent.ts` 的 `turn()`/`step()`/`preStep()`。
- **持久事件词汇**：`packages/core/session/src/types.ts` 的 `SessionEventMap`（merge-extensible，插件可 `declare module` 扩展）。
- **steering API**：`packages/core/agent/src/runtime-types.ts` 的 `Agent.steer/inject/followup/send`。
- **干预的官方先例**：`packages/guard/repeat-tool-reminder`、goal 的 `<goal_complete>` wrap-up、workspace-context 的 `Additional instructions` 通知——三者都走 plugin-source 消息 + inbox。
- **现有相近实现审计**：DSH 已内置 `repeat-tool-reminder`（单一信号 + 轻提醒，非策略重置）；官方 notes 明确 **stuck-pattern detection / no-progress heuristics 未实现**（`.agents/notes/implemented/feature/2026-07-16-harness-level-loop.md` §Known limitations）。不构成重复，构成可对比/可协作对象。

---

## 1. 可获得哪些 trajectory evidence

DSH 的持久轨迹是一条 append-only `SessionEvent` 日志（`packages/core/session/src/types.ts`），且 **"模型可见 ⟺ 已记录"** 是运行时不变量（`packages/core/session/src/invariant.ts`）。因此"模型看到的一切 + 执行边界"都可从日志重建。分两类：

### 1.1 持久证据（SessionEventMap，`session/event` 同步广播）

| 事件 | 载荷（关键字段） | dsh-evolve 用途 |
|---|---|---|
| `turn/start` / `turn/end` | `{turn}`；`{turn, reason: TurnEndReason}` | 轮次边界；终止原因（`completed/aborted/blocked/error/max-tokens/interrupted`）→ 成功/失败结果标签 |
| `step/start` / `step/end` | `{turn, step}` | Step 计数、`totalSteps`、latency 分块（`event.time` 差值） |
| `user/message` | `UserMessage{content, source}`；`source` 可鉴别 人类/plugin 注入/工具结果 | 区分"人类干预"与"自产上下文"；策略重置消息落在此处 |
| `assistant/message` | `{turn, step, message, usage?: TokenUsage}` | **token 计量的唯一记录点**（`inputTokens/outputTokens/cacheRead/cacheWrite/reasoningTokens`，见 `packages/llm/llm/src/types.ts`） |
| `assistant/chunk` | `{turn, step, chunk}` | 流式回放（本项目不需要） |
| `tool/call` | `{turn, step, callId, name, arguments: string}` | 工具名；raw 参数串 → canonicalization 输入（信号 B） |
| `tool/result` | `{turn, step, message, error?: {name, code}, meta?}` | **工具成败的持久信号**（信号 A/C/D 的主输入）；`isError` 在 `message.content[0].isError` |
| `request/header` | `{header: {config, system, tools}, reason}` | 模型/provider/上下文窗口（eval 元数据） |
| `agent/inbox/spliced` | `{target, start, removedCount?, inserted: UserMessage[], outcome?}` | 注入/steering 的持久记录；resume 时 Inbox 重放 |
| `session/end-seed` | `{}` | 恢复/续跑的分界（`firstLiveSeq`） |

补充：
- `tool/result.error` 的结构化错误码来自 `ToolExecutionResult.error.info = {name, code}`（`packages/core/tools/src/` 管道在 `tools/result` 前冻结结果；loop 只持久化 `content/error/meta`——`docs/subsystems/tools.md`）。
- 已知错误码：`TOOL_TIMEOUT`（guard/timeout-policy）、`TOOL_ABORTED_BEFORE_DISPATCH`（abort 合成）、`INVALID_ARGS`/`INVALID_TOOL_OUTPUT`/`UNKNOWN_TOOL`（registry 标准化）。注意：命令类工具（shell/bash）的错误码粒度——错误信息文本 + name/code 可用，但 **exitCode 不直接进 `tool/result.error`**（在 error.message 或 meta 内），v0.1 用 `tool+name+code+标准化文本` 作为 error signature，不依赖 exitCode 字段。

### 1.2 实时（非持久）证据

| 事件 / API | 含义 | 用途 |
|---|---|---|
| `tools/result`（emit，同步） | `(exec: ToolExecution, result: Readonly<ToolExecutionResult>)` 冻结的权威结果 | 热路径观察工具成败（比解析 session 事件更快；`exec.agent` 标识归属 agent） |
| `agent/status` | `idle/running` | 干预窗口判断 |
| `agent/inbox/*` | inserted/claimed/discarded | 会话活跃度 |
| `fs/observed`（emit） | `(target, observation{kind:'present'...version}, actor)`，由 tool-fs/tool-str-replace-editor 发出 | **低成本 workspace 变更信号**（注意：非持久，仅运行时；离线分析不可用 → v0.1 以"变异工具 + 成功结果"派生持久等价物） |
| `agent/error` | `{turn, step, error}` | 失败边界补充 |

### 1.3 结论

轨迹证据覆盖了 v0.1 全部五个 stuck 信号所需的确定性输入：失败（tool/result.isError + error）、重复调用（tool/call name + arguments）、重复错误（error name/code/文本）、无新观察（tool/result content 指纹）、工作区进展（离线用变异工具成功、在线加 fs/observed）。**不需要、也不应使用** embedding / LLM judge / 向量检索。

---

## 2. 可用哪些公开扩展 seam

### 2.1 观察面

- **`session/event`**（`packages/core/session/src/index.ts`）：`(session, event)` 同步 emit，**按 session scope 过滤**（agent-scoped listener 只收到该 agent 的 session 事件）；监听器失败被包含（记日志，不影响 append）。这是回放/恢复安全的观察通道——插件启动时对已存在 session 没有历史事件（构造 seed 不广播），因此**恢复观察必须从 `session.events` 全量折叠或从 `firstLiveSeq` 开始**（这也是离线 analyzer 的读取模型）。
- **`tools/result`**（`docs/subsystems/tools.md`）：同步、冻结、不可篡改；在工具流水线末端（post-execute/finalize 之后）触发。做"增量特征更新"的最佳热路径钩子。
- **`agent/*` 事件族**：生命周期、status、error、inbox 通知——用于状态管理与干预窗口判断。

### 2.2 干预面（三选一 + 官方先例）

| 机制 | 官方语义 | 风险评估 |
|---|---|---|
| **`agent.inject(msg)`** | 排队到 next-step inbox、不唤醒；running 驱动在最近的下一个 step 边界认领 | 主机制（工具循环中 stuck） |
| **`agent.steer(msg)`** | next-step + 唤醒；`agent/turn-stopping` 是"再走一步的最后机会"（docs → 文档明示 listener 可在此 steer） | 主机制（模型提前停止场景） |
| `agent/pre-step` 改写 `messages` | waterfall 可返回替换后的消息批次；进入的批次会被 `session.append('user/message')` 持久化 | 备选；与上面两条效果等价但会更贴近请求边界 |
| `tools/post-execute` 返回 `additionalContexts` | repeat-tool-reminder 已用此模式 | 备选；在单次工具结果后注入，但只对"模型还在调工具"有效 |

**关键结论**：`Agent.steer/inject` + `{kind:'plugin', plugin:'dsh-evolve', form:'notice'}` 的 user 消息是**一等官方模式**——仓库内 goal wrap-up、workspace-context 通知、repeat-tool-reminder 提醒全部如此。注入的消息会被持久化为 `user/message`（models 可见 ⟺ logged 自动满足），uninstall 后仍是普通的 `user/message`，**不产生新事件类型**。

### 2.3 时序验证（为什么 step/end 注入不会晚于循环检查）

`agent.ts` `turn()` 循环：
```
step() 返回后 finally { session.append('step/end') }
→ session/event 同步触发我们的监听器 → 监听器内 agent.inject()（同步 splice + 持久 agent/inbox/spliced）
→ 回到循环：if (turnEnds && inbox.nextStep.length === 0) → 因有 pending 而跳过 turn-stopping / 继续下一 step
```
所以注入的消息必然在下一次 pre-step 被认领。若步骤以 tool-result `concludesTurn` 收尾，官方语义允许"racing steering 仍会运行"（`agent/turn-stopping` JSDoc）——这属于已知边界，v0.1 记录为指标而非缺陷（见 architecture.md §Intervention 边界）。

---

## 3. v0.1 能否保持纯插件

**能。** 依据：

1. **agent-loop 本身就是可替换的插件**（`ctx.agentLoop` 服务，`AgentFactory` 通过 `ctx.agents.setFactory()` 注册）——但我们**不需要替换它**：所有需要的观察/干预点都在其之外的公开事件与 `Agent` 接口上。
2. 官方仓库中 goal、compact、workspace-context、repeat-tool-reminder、timeout-policy 等全部是"对 loop 旁挂的插件"，其中 goal 明确拒绝修改 agent-loop（note：`2026-07-16-harness-level-loop.md` "Modify the concrete agent loop with goal or Ralph modes — rejected"）。
3. 唯一会被视为"Core 改动"的是往 `SessionEventMap` 加新持久事件类型；本项目刻意不这么做（§6/§7）。
4. 插件以 bundle/patch 形态安装（`dsh plugin --profile <n> add <pkg>`），配置行级启用/禁用，无 monkey patch、无源码修改。

---

## 4. 什么运行时状态可安全观察

- **安全**：`session.events`（只读）、`session.surface`/`deriveMessages()`（只读投影）、`agent.status/inbox/session/options`、所有文档化事件的 payload、`ctx.agents` 注册表查询、`fs/observed`。
- **禁止**：`ReactLoopAgent` 的私有 `phase`/`activityDone`/`runtimeContext`（包内私有，`index.ts` 明确"concrete loop is package-internal"）；任何未导出的内部字段；依赖 `tools/execute` 返回值以外的执行内部（例如 `prepare/dispatch/finalize` 时序）。
- 观察必须**只读 + 无副作用**：不 append 事件、不修改 inbox、不在热路径同步阻塞（需异步的更新放到微任务/下个事件循环，避免在 `session/event` 同步段拖慢 loop）。

---

## 5. strategy reset 如何注入

见 §2.2。正式设计：

```text
触发（detector，纯确定性）               注入（controller，官方 seam）
  tool/result | step/end | turn-stopping
          │                                  │
  增量特征更新（O(窗口)）                    agent.inject(策略重置 user 消息)
          │                                  │  (next-step, 不唤醒)
   StuckScore ≥ threshold                    或 agent.steer(...) at turn-stopping
          │                                  │
   cooldown / maxPerTurn / maxPerSession 检查 → 记录 InterventionRecord → 注入
```

消息体（recipe 内可配，`STRATEGY_RESET` 模板见 architecture.md §Intervention）满足：
- `source: {kind:'plugin', plugin:'dsh-evolve', form:'notice', summary: boundContextSummary(...)}`（`session/event` 折叠行只显示 summary，≤120 字符，`packages/llm/llm/src/message.ts` 有 `CONTEXT_SUMMARY_MAX_CHARS`）。
- 内容聚焦"策略层面"，不含领域知识，不指示具体工具。

注入后自动获得：持久化（`agent/inbox/spliced` + 认领后的 `user/message`）、resume 安全（Inbox 重放）、卸载安全（Core 词汇）。

---

## 6. 什么不应写入 DSH Session

| 数据 | 是否写入 Session | 理由 |
|---|---|---|
| 策略重置**消息本体**（模型可见） | **是**（但走 Core 词汇） | Model-visible ⟺ logged 不变量强制；`user/message` 是官方类型 |
| StuckScore 明细、各个信号值、reason 枚举 | **否** | 非模型可见、非 loop 语义；写进日志会被其它 DSH 版本/工具按"未知但 ignorable"处理，且属于插件内部事实 |
| InterventionRecord（policyId/version/score/reasons） | **否** | 属于插件自有实验数据 → `~/.dsh/evolve/` |
| Policy Recipe | 否 | 配置/实验物 → `~/.dsh/evolve/policies/` |
| 离线分析结果 / eval 结果 | 否 | → `~/.dsh/evolve/runs|evals|reports/` |

> 设计约束：`user/message` 的注入是**唯一**允许进入 Session 的 dsh-evolve 产物，且它本来就是 DSH 为"注入上下文"设计的通道。若未来要记录非模型可见的插件事实，宁可放在 `~/.dsh/evolve/` 也不扩展 SessionEventMap（除非官方提供第三方 durable extension contract；目前 `declare module` 扩展是类型层面的合法机制，但会向持久化词汇表（`KNOWN_SESSION_EVENT_TYPES`，gen 生成）引入新类型，跨版本/跨实现存在读取拒绝风险，故不用）。

---

## 7. 兼容性风险清单

1. **未知事件类型（最大风险）**：向 Session 写入 Core 不识别的非-`ignorable` 事件，旧版本加载会拒绝（`docs/subsystems/persistence.md`：类型不在 `KNOWN_SESSION_EVENT_TYPES` → 除非 `ignorable:true` 否则读失败）。→ 本项目零新增类型。
2. **干预时机竞态**：`agent.inject` 可能错过"已认领批次的 pre-step"（API 文档明示）→ 在 step/end 监听器（循环检查 inbox 之前）注入可规避；文档化残余竞态为"最多晚一个 step"。
3. **与 `repeat-tool-reminder` 叠加**：两者都会注入 plugin 消息 → 实验设计必须固定基线组合（默认两臂都**禁用** repeat-tool-reminder，隔离策略重置效果；文档记录）。
4. **与 compaction / goal / context 插件的消息流叠加**：注入消息进入 derive 历史会增加 token 消耗（每次干预约 100–200 token）→ 计入成本指标（Q4）。
5. **卸载语义**：卸载只移除监听器/effect；`~/.dsh/evolve/` 数据保留（设计如此，见 architecture.md §Lifecycle）；若用户手动删除插件数据目录，插件下次启动自愈（目录不存在即空库）。
6. **Session format 演进**：`SESSION_FORMAT_VERSION` 目前 0；本插件不写结构、不依赖任何未稳定格式字段（只用 `event.data` 的公开字段）。
7. **Window/内存**：每 agent 的增量状态（窗口 ring buffer）随 agent 释放（`agent/disposed` 时清理），不跨会话泄漏。
8. **多 agent / subagent**：session/event 按 session scope；子代理是独立 Session（delegationDepth 等元数据），自带独立状态机；对子代理 session 也可独立启用（默认只对顶层 root session 干预，recipe 可配 `scope: root|all`）。

---

## 附录 A：证据文件索引（file:line）

- 循环驱动 `turn/step/preStep`：`packages/core/agent-loop/src/agent.ts:210( turn ),332( step ),225( preStep ),407( buildRequest )`
- `agent/turn-stopping` 串行点：`packages/core/agent-loop/src/agent.ts:296`
- 工具调度与 `tool/call|result` 持久化：`packages/core/agent-loop/src/tool-calls.ts:59(executeToolCalls),262,268`
- Agent 接口与 `agent/*` 事件词典：`packages/core/agent/src/runtime-types.ts:64(Agent),146(Events)`
- Inbox 与 `agent/inbox/spliced`：`packages/core/agent/src/inbox.ts:25`
- 持久事件词汇 `SessionEventMap`：`packages/core/session/src/types.ts:236`；`SESSION_FORMAT_VERSION:56`
- `session/event` / `session/flush` 声明：`packages/core/session/src/index.ts:37-86`；同步触发实现 `:374-399`
- 表面投影（user/message 原样投影）：`packages/core/session/src/surface.ts:83(derveEventMessage)`
- 消息源类型 `MessageSourceMap`（plugin 源可合并扩展）：`packages/llm/llm/src/message.ts:100`；`createUserMessage:192`
- `TokenUsage`：`packages/llm/llm/src/types.ts:135`
- 工具流水线事件与结果类型：`docs/subsystems/tools.md:376(Decision),645,/654,/679,/702(tools/result emit),330(ToolFailure),339,354`
- 现有重复提醒插件：`packages/guard/repeat-tool-reminder/src/index.ts`（整文件）
- 超时包装器：`packages/guard/timeout-policy/src/index.ts`（整文件）
- **无 stuck 检测的官方声明**：`.agents/notes/implemented/feature/2026-07-16-harness-level-loop.md:126`
- goal wrap-up 的 plugin 消息先例：`.agents/notes/implemented/bug-fix/2026-08-02-goal-round-wrapup-message.md`
- workspace-context 的 tools/result 观察 + inbox 通知先例：`.agents/notes/implemented/feature/2026-06-24-workspace-context.md:41`
- `fs/observed` 事件：`packages/fs/fs/src/index.ts:76`；发射端 `packages/fs/tool-fs/src/{read,write,edit,read-target}.ts`
- 存储目录：`packages/bundle/base/cordis.patch.yml:98-101( root: !!js dshHomePath('sessions') )`；Harness home `~/.dsh`：`packages/boot/app-boot/src/index.ts:4`
- Profile / bundle / patch 机制：`packages/boot/app-boot/src/profile.ts:1-120`
- CLI 插件管理（pnpm 转发 + bundle 对账）：`apps/cli/src/plugin.ts`（整文件）；launcher 参数 `apps/cli/src/args.ts`（`--profile/--patch/--dump-config/plugin`）
- 未知事件类型拒绝策略：`docs/subsystems/persistence.md:94`
- 插件注册为 effect / 生命周期：`packages/core/agent/src/index.ts:372(setFactory),450(register)`；vendored Cordis 版本与本地加固见 `vendor/README.md`（cordis 4.0.0-rc.7）

（所有结论基于当前工作树；若上游后续改动相关文件，重新运行本节索引即可复核。）