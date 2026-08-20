# tasks/ — 编码任务集（dsh-evolve eval 数据）

每个任务目录包含：

```text
tasks/<task-id>/
  workspace/        不可变 fixture（评测前复制/解包到独立 run workspace，原始目录永不被修改）
  prompt.md         任务文本（模型唯一看到的任务描述；可含约束与验收说明）
  README.md         任务说明（给人类维护者，不进模型上下文）
```

任务集清单（`tasks/example.tasks.json` 引用）：

- **parser-fix-01**：修复括号平衡检查器。bug 明确、需要阅读+推理+修改+运行 `node check.js` 自测。graders：`node check.js`（10 个断言）。

## 新增任务规范

1. bug/缺陷必须**不可通过简单文本替换修复**（避免"改变量名/改文案"型琐碎任务）；
2. 尽量包含：搜索、多文件修改、失败-重试、测试-修复循环中的至少两项；
3. `workspace/` 保持小而完整（可运行），`check.js` 是**唯一**成功判据（exit 0）；
4. 在 `example.tasks.json` 中登记并写 README；
5. 用 `dsh-evolve eval --tasks tasks/example.tasks.json --dry-run` 验证 schema 与 fixture 可解包。
