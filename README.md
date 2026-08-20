# dsh-evolve

> Evidence-driven runtime evolution for DeepSeek Harness.

[![CI](https://github.com/Atman-Angle/dsh-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/Atman-Angle/dsh-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`dsh-evolve` 是一个可拆卸的 DeepSeek Harness 插件：它观察 Agent 的执行轨迹，从重复失败、用户纠正和成功流程中提炼经验，再生成可验证、可审批、可回滚的优化提案。

它不替换 Agent Loop，不修改 DSH Core，也不接管工具、沙箱或权限系统。

## 安装

本插件面向 DeepSeek Harness 的源码插件环境。将两个仓库放在同级目录，
然后在本仓库执行 `pnpm install`、`pnpm build`，再按 DSH 的插件配置加载
`dsh-evolve`。当前 DSH 的核心包使用本地 workspace 依赖，CI 也会自动检出
`deepseek-ai/deepseek-harness` 作为同级目录。

```text
workspace/
  deepseek-harness/
  dsh-evolve/
```

完整开发和贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 它做什么

```text
Session events
    -> deterministic stuck detection
    -> experience mining
    -> mutation proposal
    -> replay / shadow / approval
    -> memory, profile, skill or policy update
```

- 在线检测重复失败、重复工具调用和无新进展轨迹，必要时注入 `STRATEGY_RESET`。
- Session 结束后异步提炼 Experience；普通 correction/procedure 默认只保存在本地经验库。
- Skill、Context、Tool 和 Runtime Policy 只生成候选提案，必须经过明确用户确认；支持验证和回滚。
- 相关经验最多临时提供 1-3 条，任务结束后清理，不写入常驻 System Prompt。
- 后台任务使用有界持久队列、重试上限和熔断器，不阻塞主 Agent。
- 原始 Session 保留在本地；可分享内容必须先经过隐私和 Secret 检查。
- Commons 同步默认关闭，开启后远程内容也只会校验、下载和本地验证，不会自动信任或执行。

## 安全边界

任何模式下都不会自动：

- 读取凭据或上传原始 Session、Prompt、源码
- 关闭 Sandbox 或绕过 Approval
- 安装第三方插件或执行社区代码
- 获取凭据、扩大系统权限
- 自动应用生成代码或插件

插件与 DSH 运行在同一进程内，因此它不是安全沙箱。只安装可信插件。详见 [docs/security-model.md](docs/security-model.md)。

## 风险门禁

| 风险 | 典型目标 | 门禁 |
| ---: | --- | --- |
| 0-1 | Memory、Preference、Skill routing | 静默记录/可见候选 |
| 2 | Recipe | Shadow |
| 3 | Skill | 显式蒸馏 + 人工确认 |
| 4-5 | Context、Tool、Runtime policy | Eval / Shadow / Rollback |
| 6 | 生成代码或插件 | 永不自动 |

## 当前状态

项目处于 `v0.1.0` 开源准备阶段，尚未发布到 npm。仓库当前通过源码构建并挂载到本地 DSH profile；Node.js 要求 `>=22.19`。

已验证内容包括：

- `pnpm typecheck`、`pnpm build`
- 218 个测试全部通过
- 发布审计 10/10 PASS
- 非干扰、故障隔离、隐私对抗和生命周期审计通过
- Session 结束后的挖掘任务支持快照恢复，任务依赖按顺序执行

审计报告见 [reports/audit/latest.md](reports/audit/latest.md)。

## 文档

- [使用指南](docs/usage-guide.md)
- [v0.2 规范](docs/spec-v0.2.md)
- [架构设计](docs/architecture.md)
- [安全模型](docs/security-model.md)
- [发布审计](docs/release-audit-v0.2.md)

## License

`package.json` 已声明 MIT。公开仓库前请补充根目录 `LICENSE` 文件。
