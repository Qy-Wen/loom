[English](./TRACE.md) | **简体中文**

# 本地 Agent Trace

开发模式将 trace 保存到 `<素材库>/.loom/agents/traces/telemetry.sqlite`。记录和指标在最后更新 30 天后过期，打开数据库时及运行期间每分钟清理。窗口展示最近 40 条 trace，支持继续加载；切库重置视图。生产构建不记录，也不包含 trace 窗口。不上传数据。

旧 `traces.sqlite` 文件保留，不读取、不迁移。

## 采集

- 将 `DurableTrace.telemetry` 经 `LibraryRuntime` 传入 `HarnessOptions.telemetry`。Pi 提供提交、阶段、请求、轮询的原生埋点、事件、指标更新和上下文持久化传播。
- `LiveTelemetry` 实现原生适配器契约，负责 span 标识、计时、links、attributes、events、status 和指标聚合。它持久化未结束 span，支持实时显示与崩溃诊断；Chord 原生 SQLite 只保存已结束 span。
- `DurableTrace.models()` 仅向已有原生请求 span 补充脱敏输入输出，不创建请求 span，不通过 signal 或 checkpoint 推断任务归属。
- 工具 hook 补充参数与结果；commit 内容观察器补充最终有界工具输出（含审批拒绝、中断诊断）。`DurableTrace` 仅从已提交状态更新 submission 摘要，并集中处理窗口状态规则；recorder 不解释 durable 事件。`ToolGate` 在审批等待期间记录 `loom.approval`。
- 原生输入提交各自建立根 trace。specialist 输入通过 links 关联调用它的工具，窗口展示关联；嵌套工具沿用原生 parent 关系。
- 独立 SQLite WAL 不参与 `.loom/agents/sessions/loom.sqlite` 的事务。请求发出前保存开始记录，内容更新按 100ms 合并，原生 span 结束时刷新。诊断写入失败会停用采集，Chat 继续运行。

崩溃后，未结束 span 标为 `interrupted`。原生 carrier 将恢复任务接回同一 trace，中断 attempt 仍保留。Trace 不调度、不重放工具。

## 内容与隐私

原生元数据包括 model/provider/API、stop reason、响应 ID、usage/cost、首 chunk 事件、阶段结果及有界错误。counter 和 histogram 按十秒时间段聚合。

输入输出沿用现有脱敏策略：移除已知 Chat 凭据和常见秘密模式；省略图片、签名、headers。请求保留最近 200 条消息，逐条限长。system/tool 长文本展示 600 字符预览，可展开已脱敏且去重的全文，全文上限 4 MiB。普通 payload 字段约限 8 KiB。

这是尽力脱敏，不是匿名化：prompt、memory、路径和工具输出仍可能含隐私。数据库未加密。

## 验证

覆盖原生适配器契约、传播与 links、实时与 SIGKILL 恢复、审批、重试、deferred poll、压缩、诊断故障隔离、脱敏、分页和 30 天清理。

独立 Electron 验收使用临时素材库和本地模型 mock：

```bash
LOOM_E2E_TRACE=1 pnpm --filter @loom/app build
cd packages/app
LOOM_E2E_TRACE=1 pnpm exec playwright test trace.spec.ts
```

Windows 请用对应 shell 的环境变量语法；普通生产构建不包含 trace 窗口。
