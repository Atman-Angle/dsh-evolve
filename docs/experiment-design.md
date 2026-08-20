# dsh-evolve 实验设计（v0.1）

> 目标：用可复现的对照实验回答四个问题（Q1–Q4），并把 **Eval 放在项目核心**而非后期补丁。
> 原则：**Success 不由 Agent 自评**；一切结论由外部确定性 grader + 轨迹数据支撑；**负结果如实报告**，不靠加功能掩盖。

---

## 1. 核心问题与假设

**主假设**：长时程编码任务中，Agent 会进入低收益/stuck 状态；一个基于确定性轨迹信号的运行时检测器 + 一次"策略重置"注入，能够在不过度干预的前提下提高成功率、降低无效步骤与 token 消耗。

| 问题 | 需要报告的度量 | 判定方式 |
|---|---|---|
| Q1 简单轨迹信号能否预测 bad outcome / stuck？ | 检测器的 **precision / recall / false-positive rate**（在真实轨迹上的离线 replay） | 以"干预后最终失败"为阳性标签做离线扫描；不只展示案例 |
| Q2 策略重置能否帮助恢复？ | **intervention recovery rate** = 注入后若干步内出现：新观察 / 工作区变更 / 完成 grader | 对照（同 session 历史反事实不可行 → 用 treatment 组内指标 + 组间比较） |
| Q3 是否提高整体成功率？ | Baseline vs Treatment 的 **Success Rate** 组间差 | 统计检验（见 §6） |
| Q4 代价是什么？ | input/output tokens、steps、tool calls、latency 的组间差 | 全量汇报，含成本×收益比 |

**容忍底线**：不允许出现"成功率 +1%、成本 ×2 却宣称更优"。任何收益主张必须同时附上成本维度。

---

## 2. 数据集（第一版）

**规模**：20–50 个真实 Long-Horizon Coding Tasks（不追求大规模 benchmark）。

**任务构成要求**（必须混合）：搜索、推理、多文件修改、工具失败、测试、修复、策略变更。禁止大量"改变量名/改文本"式的琐碎任务。每任务固定包含：

```yaml
task:
  id: parser-fix-01
  repo:  # 不可变 fixture（git 基线 commit / 打包快照，每次运行前完整还原）
    fixture: tasks/parser-fix-01/workspace.tar.zst
  prompt: tasks/parser-fix-01/prompt.md       # 与模型交互的唯一任务文本
  constraints:
    maxSteps: 60
    maxTokensOutput: 200_000                  # 预算（两臂一致）
  grader:
    commands:                                 # 外部确定性 grader
      - pnpm test parser
      - pnpm typecheck
    assertions:                               # 或文件系统断言等
      - "path: src/parser.cjs; contains: 'balanced'"
```

**fixture 不可变性**：每次运行从打包快照还原独立 workspace 副本（含 git 状态、node_modules 可选预装）；进程隔离；随机种子保证可重放（若模型 provider 支持 seed 参数则记录）。

---

## 3. 分组与隔离

### 3.1 两臂（每组每任务 ≥3 次，条件允许时更多）

```text
Baseline   = DeepSeek Harness + dsh-evolve observer（detector 全开、只记录不注入）+ 干预禁用（recipe: baseline.json）
Treatment  = DeepSeek Harness + 同一 observer + 策略重置启用（recipe: reset-v1.json）
```

同任务两臂保持：**同一模型/provider、同一 tools 集、同一系统提示、同一 workspace fixture、同一初始状态、同一任务文本、同一预算**。

### 3.2 运行编排

自定义 eval profile（`~/.dsh/profiles/eval-<arm>/`），layers = `[dsh-base, dsh-headless, dsh-evolve]` + 两臂专属 `--patch` overlay：

```text
eval-common overlay:   重复工具提醒禁用（见 §3.4）等固定因素
eval-baseline overlay: dsh-evolve.intervention.enabled=false
eval-treatment overlay: dsh-evolve.intervention.enabled=true
```

单次运行：`dsh --profile eval-<arm> --patch <task>.overlay.yml "<task prompt>"`，配 `resumeSessionId=<runId>` 唯一身份与 `cwd=<fixture>`。任务超时由外部 runner 杀掉并标记 `aborted`。

### 3.3 随机性与重复

模型抽样的随机性 => 每任务每臂重复 ≥3 次（共 ≥ 20×3×2 = 120 运行）。记录每运行的实际 provider/model/fixture hash/seed，供事后分组回归检查（如"某臂的失败集中在某 fixture 损坏"）。

### 3.4 混杂因素控制（重要）

- **repeat-tool-reminder 默认在 base bundle**：两臂都显式禁用该行（`disabled: true` patch），隔离"策略重置 vs 轻提醒"的效应。（若未来要测叠加，则单独开第三臂，v0.1 不做。）
- 不启用 goal/compaction 等可改变轨迹语义的策略插件——保持 loop 行为一致。
- observer 本身（检测+记录）在两臂完全一致，确保差异只来自"是否注入"。

---

## 4. 度量定义

| 度量 | 定义 |
|---|---|
| `success` | grader 全部通过（命令 exit 0 + 断言满足），**与 agent 文本无关** |
| `steps` | 该 session 的 `step/start` 事件数 |
| `toolCalls` | `tool/call` 事件数 |
| `inputTokens / outputTokens` | 全部 `assistant/message.usage` 求和（缺失 usage 的 step 记为 0 并单独报告 coverage） |
| `durationMs` | session 首个事件 → 最后事件的 `time` 差 |
| `stuckEvents` | 检测器触发（score ≥ threshold，无论是否注入）数 |
| `interventions` | 注入数（`user/message.source.plugin==='dsh-evolve'` 计数） |
| `stuckRate` | 存在 ≥1 stuckEvent 的运行占比 |
| `recoveryRate`（注入后恢复） | 注入后 3 步内出现"新观察 或 工作区变更"或最终 success 的注入占比（保守；多信号联合） |
| `deltaStepsAfterReset` | 注入后到结束的步数（评估 reset 是否结束低效段，与未注入对照段比较） |

EvalRunResult（落盘 `~/.dsh/evolve/evals/<taskId>/<runId>.json`）：

```ts
interface EvalRunResult {
  taskId: string; runId: string; policyId: string
  success: boolean
  steps: number; toolCalls: number
  inputTokens?: number; outputTokens?: number
  durationMs: number
  stuckEvents: number; interventions: number
  finalScore?: number            // grader 数值型输出（可选）
}
```

---

## 5. 报告（自动生成 `reports/latest.md`）

```text
# dsh-evolve experiment

Dataset:       32 tasks
Model:         deepseek-v4-flash
Runs:          96 baseline / 96 treatment

                Baseline    Evolve      Δ
Success         61.5%       68.8%       +7.3pp
Avg steps       22.4        19.7        -2.7
Avg input tk    48.2k       43.6k       -9.5%
Avg latency     8.4m        7.5m        -10.7%
Stuck runs      27.1%       15.2%       -11.9pp

Interventions:  42
Recovered:      19            (recovery rate 45.2%)
False positives: 7            (注入后既无恢复也无完成)

案例（强制）：
 明显成功案例：task-07 run-xx —— 注入发生在 step 23，此后更换策略并在 step 31 通过 grader
 明显失败案例：task-13 run-yy —— 注入 3 次均未改变轨迹，仍失败
 false positive：task-02 run-zz —— 模型本可在 step 30 自然完成，step 27 被注入打断多花 2 步
 regression：   task-19 —— treatment 成功率低于 baseline（-2 次），需归因分析
```

规则：
- 平均收益必须伴随完整成本列（Q4）。
- 若 Q3 无显著差异：**如实报告"未观察到显著提升"**，并给出统计功效说明（样本量/效应量），而不是扩大实验掩盖。
- case 报告禁止 cherry-pick：随机抽样 + 强制列出上述四类（若某类为空则写"无"）。

---

## 6. 统计方法（保守、简单）

- 组内指标用 mean ± CI（bootstrap 95%）。
- Success 用**配对（按任务配对）McNemar 检验或 bootstrap 置换检验**；steps/tokens/latency 用配对 Wilcoxon。
- 报告效应量（Cohen's h / d）与样本量；不预设"显著才算有效"，同时给出**实际意义**判断（如 token 节省 vs 成功率影响）。
- 多臂/多 recipe 比较默认在 eval 小结里做 **Bonferroni 校正**说明（v0.1 最多 2 臂，问题不大；记录在案）。

---

## 7. 离线 Analyzer 的定位与边界

- `dsh-evolve analyze <sessionId> --recipe <r>` 离线重放，输出逐 step score 与 TRIGGER 点；用途：理解 detector、扫参数、找 false positive、校准 threshold（Q1 的 precision/recall 曲线数据来源）。
- **能力边界（写入需求 §十四）**：Analyzer 只能证明"如果当时启用该 policy 会在哪些 step 触发"，**不能**证明"触发后 Agent 会变好"——后者必须由本节的真实 Online Eval 回答。因此 analyze 结果不参与 success 判定。

---

## 8. 验收标准（v0.1 完成定义）

1. `dsh-evolve analyze` 对任意历史 session 可重放，且与运行时触发一致（对同一 recipe 同一轨迹逐 step 相同）。
2. 完整的 Baseline/Treatment 对照实验跑完 ≥ 40 个任务×2 臂×≥3 次，`reports/latest.md` 自动生成且包含四类案例。
3. Q1–Q4 全部给出带数字的回答；若为负结果，报告如实陈述并给出下一步（参数扫描/信号调整）的具体建议。
4. 插件安装/卸载/重装三态各验证一遍：卸载后原 session 可读可续跑，无残留 listener/状态。