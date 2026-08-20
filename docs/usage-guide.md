# dsh-evolve 使用指南（v0.2）

> 面向使用者的操作手册。目标：把 dsh-evolve 装进真实 DeepSeek Harness 后，
> 大多数时候感觉不到它存在；只在高影响 Mutation 出现时看到一次提示。
>
> 相关文档：`docs/spec-v0.2.md`（规范）、`docs/security-model.md`（安全模型）、
> `docs/release-audit-v0.2.md`（发布门禁）、`docs/security/privilege-audit.md`（权限审计）。

---

## 1. dsh-evolve 是什么

一个**旁挂**在 DeepSeek Harness 上的自进化插件：

```text
DSH Agent Loop（原样运行）
        ↓ 事件
dsh-evolve（旁挂观察）
        ↓
后台提炼 Experience → 候选 Mutation
        ↓
低风险：静默生效（Memory / Preference / Recipe）
高风险：等你审批（Skill / Policy）
```

- **不修改** DSH Core、不替换 Agent Loop、不训练模型。
- 安装后没有任何 ACTIVE Mutation 时，与原版 DSH 的执行轨迹**逐字节一致**（见 non-interference 审计）。
- 任何 Evolve 自身故障只会导致 `evolution paused`，不会影响正常 DSH 使用。

---

## 2. 安装

### 2.1 构建

```bash
pnpm install
pnpm build          # 产出 lib/
pnpm test           # 218 个测试，可选但建议
```

### 2.2 挂载到 DSH profile

与官方插件一致，通过 bundle 方式安装到某个 profile：

```bash
dsh plugin --profile <profile名> add /path/to/dsh-evolve
```

安装层由 `cordis.patch.yml` 完成：向 profile 插入一行 `dsh-evolve` 插件（默认 `recipe: reset-v1`）。
卸载 = `dsh plugin --profile <name> remove dsh-evolve`，所有 listener / 定时器 / 后台 worker 随上下文释放，DSH 完全恢复原样（见 lifecycle 审计）。

### 2.3 快速自检

```bash
dsh-evolve status          # 看到 Runtime / Evolution / Safety / Permissions 四段即安装成功
dsh-evolve audit --all     # 发布门禁自检（10 项全 PASS 为健康）
```

> CLI 与插件共享 `~/.dsh/evolve/` 数据目录；不同机器/环境可用 `--root` 指定。

---

## 3. 配置

插件行配置（profile 中 `dsh-evolve.config`），完整字段与默认值：

```yaml
enabled: true                    # 总开关
recipe: reset-v1                 # v0.1 运行时策略：baseline（只观察）/ reset-v1（卡住重置）/ 自定义 .json
storageRoot: ~                   # 默认 <DSH_HOME>|~/.dsh/evolve

evolution:
  enabled: true                  # 进化侧车总开关
  mining: true                   # Session 结束后提炼经验
  routing: true                  # 记录 ACTIVE Skill 的命中与结果
  skillInjection: false          # 是否把 ACTIVE Skill 指令注入 agent 上下文（默认关）

  mode: balanced                 # conservative | balanced | autopilot（见 §4）

  background:
    maxQueueSize: 200            # 后台队列上限（满时丢弃最低价值任务）
    maxAttempts: 3               # 单任务最大重试次数
    failureThreshold: 3          # 熔断阈值（连续失败次数）
    cooldownMinutes: 30          # 熔断冷却时间
    workerIdleMs: 50             # worker 空闲轮询间隔

  semanticMining:                # 模型语义挖掘（默认关，永远后台）
    enabled: false
    concurrency: 1
    maxPendingJobs: 10
    quotaFailurePauseMinutes: 30 # 429/quota 后暂停时长

  commons:
    enabled: false               # 默认关闭；需显式开启 GitHub Commons 同步
    syncIntervalHours: 6         # startup/daily/6h/manual/disabled 的 6h 档
    manifestUrl: https://raw.githubusercontent.com/dsh-evolve/commons/main/registry/index.json
```

要点：

- **默认配置 = 本地优先**：Risk 0–2 自动、后台全静默、Commons 同步关闭；需要联网同步时显式开启。
- `skillInjection` 默认关闭；即使打开，也只有**已经 ACTIVE 且经过审批**的 Skill 才会被注入。
- `semanticMining` 默认关闭；打开也只会在后台空闲时运行，且被 quota 熔断保护，不与主 Agent 抢额度。

---

## 4. 用户模式（evolution.mode）

| 模式 | Risk 0 | Risk 1 | Risk 2 | Risk 3 | Risk 4–5 | Risk 6 |
|---|---|---|---|---|---|---|
| `conservative` | 自动 | 询问 | 询问 | 询问 | 询问 | 人工 |
| `balanced`（默认） | 自动 | 自动 | shadow→自动 | **询问** | 验证+**询问** | 人工 |
| `autopilot` | 自动 | 自动 | 自动 | 验证后自动* | 验证后自动* | 绝不自动 |

\* autopilot 下 Risk 3–4 自动需要**显式开启**；Risk 5 默认仍询问。
任何模式下都**永不自动**：修改 DSH Sandbox、关闭 Approval、获取凭据、执行社区代码、安装第三方插件、扩大系统权限。

```yaml
# 示例：保守模式（一切涉及未来行为的修改都要问你）
evolution:
  mode: conservative
```

---

## 5. CLI 命令参考

所有命令默认操作 `~/.dsh/evolve`，可用 `--root <dir>` 覆盖；需要结构化输出加 `--json`。

### 5.1 状态与审计

```bash
dsh-evolve status                          # 双平面健康 + 进化/安全/权限总览
dsh-evolve audit --all                     # 全部 10 项审计（写 reports/audit/latest.md）
dsh-evolve audit --security                # 权限/文件系统/网络/供应链/Skill 安全
dsh-evolve audit --privacy                 # 隐私对抗
dsh-evolve audit --runtime                 # 非干扰 + 故障隔离 + 开销
dsh-evolve audit --lifecycle               # 装载/卸载循环
dsh-evolve benchmark                       # Runtime Overhead 基准（1k/10k/100k 事件）
```

### 5.2 Experience（经验层）

```bash
dsh-evolve experience mine --sessions ~/.dsh/sessions   # 把历史 Session 批量提炼为经验
dsh-evolve experience list [--kind fact|correction|...] [--status CANDIDATE]
dsh-evolve experience detail <exp_id>
```

### 5.3 Mutations（变更提案）

```bash
dsh-evolve mutations propose                # 由经验生成提案（重复提案自动去重）
dsh-evolve mutations list [--status] [--target]
dsh-evolve mutations promote <id> --approver user     # 审批通过（Risk 3+ 默认需 user）
dsh-evolve mutations promote <id> --approver auto     # 仅限 Risk 0–1 自动档
dsh-evolve mutations promote <id> --approver policy --sessions ~/.dsh/sessions  # 策略档（带重放验证）
dsh-evolve mutations reject <id> --reason "不需要"
dsh-evolve mutations rollback <id> --reason "回归"
```

### 5.4 Skills

```bash
dsh-evolve skills list [--status]           # CANDIDATE / ACTIVE / QUARANTINED ...
dsh-evolve skills activate <skill_id>       # 激活（写入 skills/active/，agent 才可见）
dsh-evolve skills deactivate <skill_id>     # 弃用
dsh-evolve skills rollback <skill_id>       # 回滚到上一版本（版本历史不可变）
```

### 5.5 Memory / Profile / Recipe

```bash
dsh-evolve memory list
dsh-evolve profile list
dsh-evolve recipe list
```

### 5.6 Capsule（隐私编译 → 可分享单元）

```bash
dsh-evolve capsule compile --all --preview   # L1 经验 → L2 Capsule（隐私编译，fail-loud）
dsh-evolve capsule list
```

### 5.7 Commons

```bash
dsh-evolve sync [--interval startup|daily|6h|manual] [--force] [--url <manifest>]
dsh-evolve contribute [--dry-run] [--release <r>]      # ［opt-in］贡献（默认 disabled）
```

### 5.8 v0.1 保留命令

```bash
dsh-evolve analyze <sessionId> [--recipe reset-v1] [--json]
dsh-evolve eval --tasks tasks.json --profile <name> --arm baseline|treatment
dsh-evolve sweep --root ~/.dsh/sessions --scores 0.5,0.6,0.7
dsh-evolve report --baseline <dir> --treatment <dir>
```

---

## 6. 日常使用流程

### 第 1 天（安装后）

```bash
dsh-evolve status          # 确认 HEALTHY
dsh-evolve audit --all     # 门禁自检（可选）
# 然后正常使用 DSH，什么都不用做
```

### 日常

后台自动发生（全部静默）：Session 结束 → 提炼经验 → 生成提案 → Risk 0–2 自动生效、
Risk 3+ 进入 `pending approval`。

偶尔你会看到一次提示（Risk 3+ 才会出现）：

```text
dsh-evolve found a reusable procedure from 7 sessions.

Candidate Skill: typescript-schema-change
Evidence: 7 sessions / 6 successful / 1 correction
This will affect future coding tasks.

[Activate] [Ignore] [Review]
```

处理方式：

```bash
dsh-evolve status                        # 查看 pending approval 数量
dsh-evolve mutations list --status CANDIDATE
dsh-evolve mutations promote <id> --approver user   # 同意
dsh-evolve mutations reject <id> --reason "暂时不需要"  # 忽略
dsh-evolve mutations list --status ACTIVE            # 确认已生效
```

Skill 同意后还需要显式激活（Skill 生成 ≠ Skill 生效）：

```bash
dsh-evolve skills list --status CANDIDATE
dsh-evolve skills activate <skill_id>
```

### 每周

```bash
dsh-evolve status                          # 观察趋势：experiences / active mutations / 诊断数
dsh-evolve mutations list --status ACTIVE  # 回顾生效中的变更
dsh-evolve experience list --kind correction   # 重复纠正是否在减少
dsh-evolve benchmark                       # 顺带确认热路径开销稳定
```

### 长期

```bash
dsh-evolve contribute --dry-run            # 预览可分享 Capsule（隐私编译后的 L2）
dsh-evolve contribute                      # 正式暂存 → 按输出指引提交 GitHub PR
dsh-evolve sync --force                    # 手动拉取 Commons 最新经验（进入 SHADOW）
```

---

## 7. 后台机制：什么在跑、什么静默

```text
前台 Runtime Plane（每事件 O(1)）
  event capture → 规范化 → 有界缓冲 → 入队
  不做：LLM / embedding / 全 Session 扫描 / Eval / GitHub / 隐私分析 / Skill 生成

后台 Evolution Plane（session-settled / idle / maintenance / manual）
  提炼经验 / 聚合证据 / 提案规划 / 隐私编译 / Commons 同步 / Shadow 验证
  有界持久队列（≤200，3 次重试，满则丢弃低价值任务，崩溃可恢复）
```

- **静默**：Risk 0–2（Memory 事实、偏好、Skill 路由、Recipe）后台自动，不打扰。
- **一次提示**：Risk 3+（Skill 创建/更新、Context/Tool/Runtime Policy）出现时。
- **永不打扰**：Commons 同步失败、熔断、后台任务失败 —— 只写诊断日志，用户无感知。

---

## 8. 故障处理（Fail-open 保证）

Evolve 任何故障（miner 崩溃 / 429 / GitHub 挂掉 / 存储损坏 / 恶意内容）都只影响 Evolve 自己：

```text
dsh-evolve failure
  → 熔断对应能力（semantic-miner / commons / store / privacy ...）
  → 记录诊断（~/.dsh/evolve/diagnostics/）
  → 原版 DSH 继续运行
```

排查手段：

```bash
dsh-evolve status                       # Runtime 段查看各能力健康；诊断数
# 诊断内容在 ~/.dsh/evolve/diagnostics/diagnostics.jsonl（最多保留 200 条）
# 熔断自动恢复：冷却期后 HALF_OPEN 探针成功即恢复 CLOSED
```

例如：

```text
Runtime
  observer            HEALTHY
  background queue    2 pending
  semantic miner      DISABLED
  commons             HEALTHY
  diagnostics          3
```

> Commons 同步完全后台：启动时先用本地已验证缓存（或没有缓存就直接不用 Commons），
> 异步检查 GitHub，绝不阻塞 DSH 启动。

---

## 9. 安全边界（使用须知）

**dsh-evolve 可以**：观察 DSH 运行事件、写自己的本地存储、生成候选进化产物、同步经校验的 GitHub Commons 数据。

**dsh-evolve 不会**：读取凭据、绕过 Approval、关闭 Sandbox、静默安装插件、执行社区代码、上传原始 Session / Prompt / 源码。

**注意**：DeepSeek Harness 插件在进程内运行 —— **只安装可信插件**。dsh-evolve 不是强隔离沙箱。

数据层级：L0 Raw Session 只留在本地 → L1 私有经验（默认本地）→ L2 结构化 Capsule（可贡献，opt-in）→ L3 社区先验（可下载、永不自动信任）。

---

## 10. 卸载

```bash
dsh plugin --profile <name> remove dsh-evolve
```

- 行为完全恢复：无残留 listener / 定时器 / worker / 全局状态。
- 数据保留在 `~/.dsh/evolve/`（卸载 ≠ 删数据；想清空直接删目录即可，不影响 DSH）。
- DSH 自己的 Session 日志原样保留，可继续读取/回放。

---

## 11. 常见问题（FAQ）

**Q：装了之后我的 Agent 会不会变慢？**
不会。热路径每事件 O(1)，实测开销约 1–3µs/事件（`dsh-evolve benchmark`）；后台工作全部在 Session 结束后进行，主 Agent 从不等待。

**Q：会不会偷偷消耗我的模型额度？**
默认不会。确定性 Miner 零模型调用；语义 Miner 默认关闭，即使打开也是后台 + 单并发 + quota 熔断。

**Q：什么时候会弹提示？**
只有 Risk ≥ 3 的 Mutation（Skill 创建/更新、Context/Tool/Runtime Policy）出现时，弹一次。Risk 0–2 完全静默。

**Q：Evolve 崩了 DSH 会怎样？**
DSH 不受影响。熔断暂停对应能力并记录诊断（见 §8），这是经故障注入测试证明的（failure-isolation 审计）。

**Q：怎么让 Skill 生效？**
`mutations promote <id> --approver user`（同意提案）→ `skills activate <skill_id>`（激活）。两步都完成后 Agent 才会在匹配任务时看到该 Skill。

**Q：社区经验会被直接用到吗？**
不会。`dsh-evolve sync` 只把社区 Capsule 下载到本地 registry（AVAILABLE → DOWNLOADED），匹配任务后进入 SHADOW，积累足够本地证据并经审批后才可能本地生效。

**Q：我的隐私数据会离开设备吗？**
不会。原始 Session 永不离开设备；可分享的只有经 Privacy Compiler 编译的结构化 Capsule，编译时发现 PII/Secret/路径/仓库信息会 **fail-loud 拒绝**而非擦除后上传；贡献默认关闭、手动触发。

---

## 12. 快速参考卡片

```text
安装      pnpm build && dsh plugin --profile <n> add /path/to/dsh-evolve
自检      dsh-evolve status && dsh-evolve audit --all
日常      无操作（后台静默）；收到提示时：mutations promote/reject
激活Skill mutations promote <id> --approver user && skills activate <id>
贡献      dsh-evolve contribute --dry-run → contribute
审计      dsh-evolve audit --all（发布门禁）
基准      dsh-evolve benchmark
卸载      dsh plugin --profile <n> remove dsh-evolve
```
