# dsh-evolve

> 面向 DeepSeek Harness 的本地执行经验插件。

[![CI](https://github.com/Atman-Angle/dsh-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/Atman-Angle/dsh-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`dsh-evolve` 旁挂在 DSH Agent Loop 之外：它记录重复失败、用户纠正与成功路径；可选地在 Session 结束后提炼本地 Experience，并为后续相似任务提供有界、临时的经验摘要。它不训练模型、不修改 DSH Core，也不接管 Sandbox、Approval 或凭据。

## 功能与边界

- 用确定性信号识别重复错误、重复工具调用和无进展轨迹；`reset-v1` recipe 可注入一次通用 `STRATEGY_RESET`。
- 可选经验侧车在后台挖掘 correction、successful-procedure 与 failure-pattern；主 Agent 路径不等待。
- 普通 Experience 默认只保存、检索和临时提供；只有显式 Skill 蒸馏和用户确认才能产生或激活 Skill。
- 经验检索按相关性、置信度和兼容性过滤，最多返回 3 条；任务结束后不保留为常驻上下文。
- 原始 Session、Prompt、工具输出和本地数据不会自动上传；Commons 同步默认关闭。

## 前提条件

- Node.js `>=22.19`
- pnpm 10
- 可运行的 DeepSeek Harness profile

当前项目使用 DSH 源码 workspace 依赖进行开发，因此将两个仓库放在同一目录下：

```text
workspace/
  deepseek-harness/
  dsh-evolve/
```

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
git clone https://github.com/Atman-Angle/dsh-evolve.git
Set-Location .\dsh-evolve
pnpm install
pnpm build
```

## 安装到 DSH Profile

先在 `dsh-evolve` 根目录完成构建，然后把本地 checkout 加入目标 profile：

```powershell
dsh plugin --profile <profile-name> add .
```

例如：

```powershell
dsh plugin --profile web add .
```

该包声明了 `cordis.patch.yml`，DSH 会将 `dsh-evolve` 插件行加入 profile。卸载时执行：

```powershell
dsh plugin --profile <profile-name> remove dsh-evolve
```

## 配置

默认 bundle 使用 `reset-v1`：检测到明确的卡住轨迹时，最多按 recipe 的冷却与总量限制注入通用策略重置。若只想观察，不注入，请在 profile 的后续 Cordis patch 中覆盖为：

```yaml
- id: dsh-evolve
  config:
    recipe: baseline
```

Experience 挖掘侧车只有在显式提供 `evolution` 配置时才启用。下面是最小的本地经验配置：

```yaml
- id: dsh-evolve
  config:
    evolution:
      enabled: true
      mining: true
      routing: true
      skillInjection: false
      commons:
        enabled: false
```

常用开关：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `recipe` | `reset-v1` | `baseline` 只记录；`reset-v1` 可注入策略重置。 |
| `evolution.enabled` | `true` | 启用或关闭经验侧车。 |
| `evolution.mining` | `true` | 在 Session 结束后挖掘本地 Experience。 |
| `evolution.routing` | `true` | 记录已激活 Skill 的任务匹配结果。 |
| `evolution.skillInjection` | `false` | 仅在已激活 Skill 场景下允许注入其说明。 |
| `evolution.commons.enabled` | `false` | 启用 Commons 缓存同步；不会自动信任或激活远端内容。 |

## 日常使用与诊断

插件装载后无需每个任务手动操作。它在 Session 结束后将数据写到 DSH evolve 根目录（默认由 DSH_HOME/用户目录解析；也可通过 `storageRoot` 覆盖）。可用 CLI 检查本地状态：

```powershell
dsh-evolve status
dsh-evolve experience list
dsh-evolve mutations list
dsh-evolve audit --all
dsh-evolve benchmark
```

对可能改变未来行为的内容，先查看提案与证据，再显式确认；不要把普通 Experience 当作自动生效的 Skill 或策略。

## 数据与安全

本插件不会自动读取凭据、关闭 Sandbox、绕过 Approval、安装第三方插件、执行社区代码或上传原始 Session。它与 DSH 运行在同一进程内，不是安全沙箱，请只安装可信插件。详细模型见 [安全模型](docs/security-model.md)。

## 开发与验证

```powershell
pnpm typecheck
pnpm build
pnpm test
```

项目导出 Cordis 插件入口、经验检索器、存储层、验证流程和离线 CLI。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，设计边界见 [开发规范](docs/development-spec.md) 与 [架构](docs/architecture.md)。

## License

[MIT](LICENSE)
