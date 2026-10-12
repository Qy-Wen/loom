[English](./TRACE.md) | **简体中文**

# 本地 Agent Trace

开发模式将 trace 保存到 `<素材库>/.agents/traces/traces.sqlite`。Traces 窗口显示当前素材库最近 40 条运行，可继续加载更早记录；切库时重置视图。刷新和重启后保留，不自动删除、不上传。生产构建不启用记录，也不包含 trace 窗口。

## 边界

- `DurableTrace` 是 Loom 自有 extension 与 commit 观察器。按 submission/task/conversation ownership 归属，覆盖并行 specialist 和嵌套调用；不调度、不重试、不改变模型上下文。
- `traceModels()` 观察公开 `Models` 请求、压缩请求和 deferred poll；原样转发 options、事件与结果，不抢先消费流。诊断故障不能让 Chat 失败。
- 独立 SQLite WAL 原子保存记录 revision，与 `.loom/loom.sqlite` 分离。provider dispatch 前保存请求开始；实时更新按 100ms 合并，结束边界刷新。它不是恢复 checkpoint，也不与 durable 做分布式事务；崩溃可能丢失最后一段诊断更新。
- 任务时间使用原生 `startedAt`/`endedAt`；工具 `durationMs` 单独表示执行时间，区别于审批等待/任务总时长。首内容时间是 Pi 内容观察时间，不是 HTTP TTFT。不采集 HTTP headers/status 或原始网络 payload。

## 内容与隐私

根运行包含 generation、模型请求、工具、审批等待、重试、压缩 span。后台/手动压缩单独记录。模型 span 包含 model/provider/API、stop reason、可用的响应 ID、token/cache usage，以及限长输入输出；工具结果包含已提交 diagnostics。窗口按 revision 更新同一记录。

落盘前移除已知 Chat key 和常见凭据字段/模式；省略图像、签名与 headers。每个输入/输出字段约限 8KiB UTF-8 文本。**这是尽力脱敏，不是匿名化：** prompt、memory、源文本、文件路径和工具输出仍可能含隐私。数据库未加密，请保护素材库，不要随意分享 trace。

崩溃后未结束 span 标为 `interrupted`。原生恢复接回同一条持久化 trace，增加新的模型 attempt，保留中断 attempt。unsafe 工具保留不确定结果，trace 不会重放工具。

## 验证

测试使用临时素材库，覆盖连续运行、结束前实时更新、ownership、审批/重开、重试、deferred poll、压缩、Stop、诊断故障隔离、脱敏、分页，以及流式/unsafe 工具执行中 SIGKILL。

独立 Electron 窗口验收（不使用个人素材库）：

```bash
LOOM_E2E_TRACE=1 pnpm --filter @loom/app build
cd packages/app
LOOM_E2E_TRACE=1 pnpm exec playwright test trace.spec.ts
```

Windows 请用对应 shell 的方式设置 `LOOM_E2E_TRACE=1`。验收标记仅在 `LOOM_E2E=1` 时启用测试窗口；普通生产构建仍不包含它。Windows 实机验收尚未完成。
