[English](./MIGRATION.md) | **简体中文**

# Agent Core 迁移 — pi `packages/agent` harness → `pi-durable`

> 评估把当前 vendor 的 Pi harness 换成 `@earendil-works/pi-durable`。当前架构见 [AGENT](./AGENT.zh-CN.md)。
> 本文记录范围、逐文件映射、能力对照、telemetry，以及待定决策。本文假设完全向后不兼容：旧会话文件直接丢弃。迁移落地后同步更新 [AGENT](./AGENT.zh-CN.md)。

---

## 1. 背景

v0.85.1 时，vendor 的 `packages/agent` 是两层合体：

- **agent loop**：`agent.ts`、`agent-loop.ts`、`types.ts`、`proxy.ts`、`stream-fn.ts`
- **harness**：`harness/**` —— `AgentHarness`、`AgentLane`、`Session` / `JsonlSessionRepo` / `MemorySessionRepo`、内置工具、`loadSkills`、compaction、telemetry

Pi 1.1.0 把它们拆开，并且 **harness 不再留在 `packages/agent`**：

| | v0.85.1 | 1.1.0 |
|---|---|---|
| `packages/agent` | loop + harness | `@earendil-works/pi-agent-core`：只剩底层 loop |
| harness | 在 `packages/agent` 内 | `@earendil-works/pi-durable` 1.1.0，基于 `chord`（storage / task / document / transaction）重写；**不依赖 pi-agent-core** |
| telemetry 生产者 | harness 调用 `startAiSpan` / `startHarnessSpan` | 无 |

结果：vendor 的 `harness/**` 没有上游后继分支，被冻结在 v0.85.1，只能由 Loom 自己维护。

---

## 2. 是否必须迁移

**不是功能需求。** 旧 harness 本就有 session、自动压缩（threshold + overflow）、重试、崩溃恢复、fork、usage、图像处理。durable 是一次重构，能力大体相同，另加：

- 子任务 / 归属子代理（旧 harness 没有）
- SQLite / JSONL / Memory / Durable Object 存储，附一致性测试（旧：JSONL + memory）
- 可热替换的 extension / section / hook / wrap 注册表
- 结构化工具输出、嵌套工具调用（`executeTool`）、code mode

durable 缺：telemetry 生产者、Agent Skills 加载器、prompt templates。

因此迁移的动机是**长期可维护性**（不再 fork `harness/**`，跟住上游），而不是新能力。若这不是重点，留在 v0.85.1 完全可行。

---

## 3. 范围：以 durable 的特点为准，不局限在 `@loom/agent`

迁移应顺着 durable 的原语走——conversation、entry、document、task、submission、registry、watch/view——而不是把它们包成旧的 `HarnessSessionManager` / lane API。因此 `packages/app` 也在范围内。

具体含义：

- **用 owner，不用 lane。** 用 durable 形态的 owner 取代 `HarnessSessionManager`：每个打开的库一个 `Harness` 加一个 `Registry`，对外暴露 `Conversation` 句柄。不再有 `lane`、`accept`、`drive`，也不手写 recovery。
- **App 状态用 document。** 会话 title、archive 标记以及其他 Loom per-conversation 状态改成 `defineDoc`，在 commit 中读写，而不是 session 旁路值。
- **Busy 用 inbox。** steer / follow-up / reject 用 `submit(..., { whenBusy })` 和 `pi.inbox`，不再手写 follow-up map。
- **Specialist 用归属子代理。** `run_retrieve_agent` / `run_create_agent` 改成归属 conversation（`ownership: { kind: "task", taskId }`），不再是每次调用一个内存 harness。
- **工具与提示用 registry。** Loom 工具、系统提示、skills/memory 注入、权限门禁都做成一个 extension（tools、sections、hooks、wraps），装进 registry。
- **UI 消费已提交状态。** App 读 `conversation.viewState()` / `watch()` 和/或 `watchEvents()`。`LoomAgUiAgent` 仍是 AG-UI 协议边界，但输入从 `LoomAgentEvent` + manager 方法变成 durable 的 view/event。
- **每库一个 SQLite 存储**（例如 `<library>/.loom/loom.sqlite`），取代 `harness-sessions/` JSONL 目录。

值得保留（作为待确认的偏好，而非硬规则）的边界：AG-UI 仍是前端协议，`packages/app` 优先使用薄的 `@loom/agent` facade，而不是直接 import `pi-durable` 类型。是否保留 facade、还是让 app 直接用 durable 句柄，是 §9 的决策 1。

`packages/agent` 之外会牵动的文件：会话列表（→ `scanConversations` + Loom document）、renderer 的会话/上下文面板、dev-trace（§8），以及所有依赖旧 session manager 行为的 `packages/app` 调用点。

**完全不兼容。** 旧的 `<library>/.loom/harness-sessions/` JSONL、存储的 transcript 形状、`attachments` 旁路字段、`loom_user_stop` entry projector 全部丢弃。一个库只保留一个 durable 存储；旧会话文件直接忽略，不做迁移。按最干净的设计做，不为存量写读取器。

---

## 4. 依赖变化

| 依赖 | 现在 | 迁移后 | 说明 |
|---|---|---|---|
| `@earendil-works/pi-ai` | 0.85.1 | 1.1.0 | `createModels` / `createProvider` 移到 `/models`；核对 API factory 路径 |
| `@earendil-works/chord` | 0.85.1 | 1.1.0 | `BACKGROUND_CONTEXT`、`Context` 从 `@earendil-works/chord/context` 取 |
| `@earendil-works/pi-durable` | — | vendor 源码 | 新 harness，vendor 到 `vendor-pi-durable/src`；子路径用 `#vendor/pi-durable/*` 映射；见下方 Vendoring |
| SQLite 驱动 | `better-sqlite3`（检索库） | durable 用 `node:sqlite`；core 的 `better-sqlite3` 不变 | durable 的 `/storage/sqlite/node` 用 Node 内置 `node:sqlite`（`DatabaseSync`）。两个驱动并存，对应不同文件（durable 的 `.loom/loom.sqlite` 与 core 的检索库）；统一驱动不在本次范围。见 §9 |
| `@earendil-works/pi-telemetry` | 0.85.1 | 1.1.0 | 只剩契约；pi 1.1.0 内没有任何运行时生产者 |
| `@silvia-odwyer/photon-node` | 0.3.4 | 删除 | durable 的图像处理改用 `@silvia-odwyer/photon` |
| `@silvia-odwyer/photon` | — | 0.3.3 | durable 依赖，供 `createNodePhotonImages()` 使用 |
| `diff`、`typebox` | 固定 | 保留 | `diff` 若 Loom 需要 edit diff；`typebox` 用于 Loom 工具 schema |
| `ignore`、`yaml` | 固定 | 仅在自研 skills 时保留 | 它们服务于旧 `loadSkills` |

### Vendoring durable

durable 以源码 vendor 进来，方式和现在的 `packages/agent` 一样。把 `vendor-pi-agent/` 换成 `vendor-pi-durable/`：

```
packages/agent/
├── package.json        # imports: "#vendor/pi-durable", "#vendor/pi-durable/tools", ...
├── tsconfig.json       # 对应的 paths
├── src/                # Loom 代码；唯一 import #vendor/pi-durable 的地方
└── vendor-pi-durable/
    ├── UPSTREAM        # repo: .../pi.git, directory: packages/durable, ref, commit
    ├── sync.sh         # 镜像 pi 的 packages/durable/src
    └── src/            # 拷贝进来的 pi 源码，可改
```

`sync.sh` 用 `rsync --delete` 镜像 `packages/durable/src/`（排除 `**/*.test.ts`、`**/testing/**`、`benchmark/**`），把 ref + commit 写进 `UPSTREAM`，默认 ref 用 `v1.1.0`。`UPSTREAM.directory` 改为 `packages/durable`。

入口：把 Loom 用到的 durable 子路径通过 `imports` / tsconfig 映射：

- `#vendor/pi-durable` → `vendor-pi-durable/src/index.ts`
- `#vendor/pi-durable/tools` → `vendor-pi-durable/src/tools/index.ts`
- `#vendor/pi-durable/env/node` → `vendor-pi-durable/src/env/node.ts`
- `#vendor/pi-durable/images/node` → `vendor-pi-durable/src/images/node.ts`
- `#vendor/pi-durable/storage/sqlite/node` → `vendor-pi-durable/src/storage/sqlite/node.ts`
- `#vendor/pi-durable/storage/jsonl/node` → `vendor-pi-durable/src/storage/jsonl/node.ts`

应用代码仍然只 import `@loom/agent`；保持单一边界（`pi-adapter.ts` 或新的 `durable-adapter.ts`）。

外部依赖仍走 npm，并与 durable 版本对齐：`@earendil-works/chord` 1.1.0、`@earendil-works/pi-ai` 1.1.0、`typebox`、`diff`，以及新增 `@silvia-odwyer/photon`（durable 的图像处理用它，不是 `photon-node`）。pi-agent-core 不再需要。

vendor 分支规则不变：`vendor-clean` 存纯净上游，`main` 放本地改动，只在 `vendor-clean` 上 sync，Loom 自己的新增放到 `src/`，不要放进 `vendor-pi-durable/src/`（下次 sync 会被删）。

因为 durable 是 Experimental 且改动频繁，预期合并会比旧 harness 更折腾。vendor 也顺带让 §8 的 telemetry 方案 B 变得可行：可以直接给 vendor 里的 generation / tool task 打点。

---

## 5. 逐文件映射

| 文件 | 旧依赖 | 新做法 |
|---|---|---|
| `pi-adapter.ts` | `convertToLlm`、`AgentMessage` | `buildChatModels` 保留（pi-ai 1.1.0）。`convertToLlm` / `toProviderMessages` 不再需要：durable 的 entry 直接带 `model: Message[]`，附件折叠改到 submit 时做 |
| `pi-tools.ts` | `AgentHarnessTool`、`createReadTool({imageProcessor})`、`createBashTool({prepare})`、`ExecutionToolContext` | 改用 durable `createCodingTools()` / `createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool`；`toHarnessTool` 重写为 `defineTool`（`execute(args, api, context)` → `{ output, details }`）。bash `prepare` 变为 `BashExecution {command, cwd, env, inheritEnv}` + `api` + `context`，适配 `prepareSandboxedBash`。`ExecutionToolContext` / `setCwd` 消失：env 由 `HarnessOptions.env` 按 conversation `cwd` 每次构建 |
| `read-image.ts` | `ReadImageProcessor` / `ReadImageProcessorResult` | 换成 durable `ImageProcessor.prepare(bytes, mimeType, limits) → PreparedImage`；直接用 `createNodePhotonImages()` 并删掉本文件 |
| `library-skills.ts` | `loadSkills`、`formatSkillsForSystemPrompt` | 无等价导出；在 durable `ExecutionEnv` 上自研，或移植 coding-agent 的 `core/skills.ts`。目录注入改成 prompt `section` |
| `library-auto-memory.ts` | `AgentHarnessTool`、`ExecutionToolContext` | 仅类型替换为 `defineTool` + `ToolExecutionApi`。注入改成 `section` / `instructions` |
| `agent-instructions.ts` | — | 映射到 per-conversation `instructions`（渲染为 `instructions` section） |
| `specialist.ts` | `AgentHarness` + `MemorySessionRepo` | 去掉"每个 specialist 一个内存 harness"；改用 durable 归属子代理：`api.commit(tx => tx.createConversation({ownership:{kind:"task",taskId:api.taskId}}))` + `api.conversation(child).submit().wait()` |
| `harness-session-manager.ts` | `JsonlSessionRepo`、`AgentHarness.create`、`lane.accept/drive/followUp/abort/resume`、`hooks.on`、`events.on`、`estimateContextTokens`、`laneConfig/laneState/value` | 整体重写——见 §6 |
| `run-trace.ts` / `trace-io.ts` | `withTelemetryContext`、pi-telemetry span | 基于 `watchEvents` + generation/tool hook 重建，或砍掉——见 §8 |
| tests / evals | `AgentHarness`、`JsonlSessionRepo`、`NodeExecutionEnv`、`estimateTokens`、`findCutPoint`、`span-io` | 逐个重写；`BACKGROUND_CONTEXT` 改从 `@earendil-works/chord/context` 取 |

---

## 6. Session manager：替换，而不是移植

旧 `HarnessSessionManager` 把 lane、session、recovery、事件翻译都揽在自己身上。durable 把这些职责拆给 `Harness`、`Conversation`、task 和 view；durable 形态的 owner 应该委派给它们，而不是重新实现。旧 API 到 durable 的对照清单：

| 现在 | durable |
|---|---|
| `JsonlSessionRepo({ fileSystem, sessionsRoot })` | `openNodeSqliteStorage(file)`（推荐；JSONL 全量驻内存）或 `openNodeJsonlStorage(dir)`——Node SQLite 适配器用 `node:sqlite`，见 §9 |
| `AgentHarness.create({ session, models, model, tools, toolContext, systemPrompt, toProviderMessages, compaction, ... })` | `Harness.open(storage, { models, registry, settings, env })` |
| `harness.lane("main")` + `lane.accept({kind:"prompt"})` + `lane.drive()` | `harness.root()` / `harness.conversation(id)` → `conversation.submit({type:"input", content, requestId})` → `submission.wait()` |
| `lane.abort`、`lane.resume`、手写 recovery | `conversation.abort()`、`harness.resume()`、带 `requestId` 的幂等 `submit` |
| `lane.followUp` / steering | `submit(..., { whenBusy: "steer" \| "followUp" \| "reject" })` |
| `lane.navigateTree` / `repo.fork({ scope:"branch", position:"before" })` | 有 `conversation.fork(at, ...)`；**"回到某条 user 消息之前"没有直接对应**——fork 后切换，或 reset |
| `session.setName` / `setValue(ARCHIVED)` | 无 title/archive 概念；用 per-conversation `defineDoc` 或 entry 自存 |
| `session.getValue(laneConfig/laneState)` | `conversation.configure()` / `conversation.agent()` / `harness.inspect()` |
| session 列表 | `Storage.scanConversations({ ownerConversationId?, order? })`；无 `cwd` 过滤，"一库一组"需自建归属映射 |
| `hooks.on("before_tool", …)` | `defineExtension({ hooks: [hook(ToolTask, { beforeTool: call => … })] })`；`call.id/name/arguments` 可用；异步等用户审批仍可行 |
| `events.on("message_update" / "thinking_*" / "tool_*" / "usage" / "compaction_*" / "retry_*")` | `watchEvents(harness, conversationId)` 的 `AgentEvent`（`message_update` delta、`tool_execution_*`、`auto_retry_*`、`compaction_*`、`usage_changed`），或 `conversation.watch()` / `viewState()`；重写 `LoomAgentEvent` 翻译 |
| `estimateContextTokens` / `calculateContextTokens` | 不导出；用 `harness.usage()` / `pi.usage`，或砍掉上下文百分比显示 |
| `entryProjectors: { loom_user_stop }` | 自定义 entry kind + `entry.model`，或 generation hook |

**等待审批**在 durable 里没有事件。`beforeTool` 可以 await，所以门禁机制成立；等待状态由 Loom 发布——一个 Loom `defineDoc`（等待中的审批）用 `watchDoc` 观察，加一个 Loom 自有事件——因为 durable 的 `watchEvents` 流不能注入。

---

## 7. 能力对照

| 能力 | 旧 harness | durable |
|---|---|---|
| Session / branch / values | 有 | 有（conversation / document） |
| 自动压缩（threshold + overflow） | 有 | 有（`settings.compaction`，另加手动 `compact()`） |
| 重试 | 有（`RetryPolicy`） | 有（`auto_retry_*`） |
| 崩溃恢复 | 有（`recovery.ts`、`lane.resume`） | 有（`harness.resume()`、durable task） |
| Fork | 有（`repo.fork`） | 有（`conversation.fork`） |
| Usage | 有 | 有（`pi.usage`、`harness.usage()`） |
| 图像处理 | 有（`tools/image.ts`） | 有（`createNodePhotonImages`） |
| 子任务 / 归属子代理 | **无** | 有 |
| 存储后端 | JSONL + memory | SQLite / JSONL / memory / Durable Object |
| 可热替换注册表 | 无 | 有（extension/section/hook/wrap） |
| 结构化输出 / 嵌套工具 / code mode | 无 | 有 |
| telemetry span | 有 | **无生产者** |
| Agent Skills 加载器 | 有 | **无** |
| prompt templates | 有 | 只有 section |

---

## 8. Telemetry

`pi-telemetry` 1.1.0 作为契约仍然完整，但 **pi 1.1.0 内没有任何运行时产出 span**：只有 `pi-ai` 引用它（仅透传 `ProviderRequestOptions.telemetryContext` 类型），没有任何地方调用 `startSpan`。旧 harness 是唯一生产者，durable 没有。

旧 harness **实际**产出的（不是 schema 声明的）：

| Span | 实际写入属性 |
|---|---|
| `pi.ai.request` | start：operation / provider / model / api / streaming；end：`stop_reason`、`usage.*` |
| `pi.harness.step` | lane / operation / `step.kind` / `step.attempt` / `compaction.reason` → `step.outcome` |
| `pi.harness.turn` | lane / operation / `turn.id` |
| `pi.harness.tool` | lane / operation / turn / `tool.name` / `tool.call_id` / `tool.replay` / `tool.recovery` → `tool.is_error` |
| `pi.harness.run` | session / lane / operation / `operation.recovery` → `operation.outcome` |
| `pi.harness.compaction`、`pi.harness.navigation` | 同 run |
| `pi.harness.hook` | `hook.name` → `hook.outcome` |

schema 声明但**从未产出**：`pi.harness.checkpoint`、`pi.harness.sleep`、`pi.harness.event_handler`、`pi.session.write`，以及 `pi.ai.request` 的 end 属性 `http.status_code`、`stream.chunk_count`、`stream.time_to_first_chunk_ms`、`response.id`、`response.model`、`error.type`。它们本来就空，不算迁移损失。

Loom 自己加的 `loom.io.input` / `loom.io.output`（模型请求、助手回复、工具 args/result）需要重新拥有。

durable 接入点：

| 旧 span | durable 缝 | 保真度 |
|---|---|---|
| `pi.ai.request` | `hook(GenerationTask, { beforeRequest, afterResponse })`；provider/model/api 从 `pi.agent` + `HookApi.models.getModel()` 取 | 好 |
| stop reason / usage / `durationMs` / `responseId` / `responseModel` / `diagnostics` | `AssistantMessage` | 完全（比旧版还多） |
| `loom.io.input` / `loom.io.output` | `beforeRequest.messages` / `afterResponse` 的 message（需自己把结构化 system sections 渲染成文本） | 好 |
| `pi.harness.run` / `turn` / `step` | `watchEvents` 的 `run_*` / `turn_*` + `beforeRequest` attempt + `auto_retry_*` | 好（时间按事件到达近似） |
| `pi.harness.tool` | `ToolTask` 的 `beforeTool` / `afterTool`，或 `wrapTool` | call id / name / is_error 有；`replay` 需自己维护 name→策略表；`recovery` 拿不到 |
| `pi.harness.compaction` | `compaction_start` / `compaction_end` | 完全 |
| `pi.harness.hook` | 只能包 Loom 自己的 handler | 部分 |
| `pi.harness.navigation` | 无 | 不需要 |

无法消除的差距：

1. **deferred 请求**：`classify()` 在 `stopReason === "deferred"` 时会在 `afterResponse` 之前 return，`beforeRequest → afterResponse` 无法包住 deferred 请求；需用 `deferred_poll` 兜底或合并 span。
2. **工具 recovery**：recovery 走 `execute` 阶段，不触发 `beforeTool` / `afterTool`，所以 `pi.tool.recovery` 拿不到；`wrapTool` 能包住执行，也不易判定是恢复。
3. `loom.io.input` 里的 system prompt 文本需从 durable 的结构化 `sections` 渲染。
4. HTTP status / chunk count / TTFT 两版 pi-ai 都不产出。

两种接法：

- **A. 外挂（推荐）**：一个 telemetry extension（`hook(GenerationTask, …)` + `hook(ToolTask, …)`），每个 conversation 一个 `watchEvents` 观察器，加一个 Loom 自有的可手动 start/end 的 `TelemetryContext`，用 `conversationId` / `taskId` / `callId` 维护 span 树。只要 span 名/属性对齐，`LoomTraceSpan` 和 dev-trace UI 无需改动。
- **B. Fork durable**：把 `harness/telemetry.ts`（schema + `startAiSpan` / `startHarnessSpan` / `recordAiResult`）移植进 durable 的 generation / tool / compaction task。更接近旧结构，但给一个 Experimental 包加 fork。

两者都需要重新拥有 `AI_TELEMETRY_SCHEMA` / `HARNESS_TELEMETRY_SCHEMA`（在旧 vendor 里，会随 vendor 消失；`pi-telemetry` 仍提供 `defineTelemetrySchema` / `createTypedSpanStarter`），并放弃 `withTelemetryContext`——durable 不从 chord `Context` 读 telemetry。

---

## 9. 决策

已定：

1. **Facade 还是直接用 durable 类型 → 薄的 `@loom/agent`。** 转发 durable 的通用类型与句柄（`Harness`、`Conversation`、`EntryRecord`、`ConversationView`、`watchEvents`、`defineTool` / `defineExtension` / `section` / `hook` / `defineDoc`）；只包装 Loom 特有的装配与策略——工具集、提示 section、skills/memory、权限门禁、Loom 文档、每库一个 `Harness` 的生命周期。`packages/app` 的 main 持 durable 句柄；IPC 与 renderer 仍走 Loom DTO，让上游 churn 不穿过进程边界。判定：通用运行时与活句柄转发，Loom 特有与跨进程包装。
2. **UI 输入 → durable `watchEvents`。** AG-UI 由 durable 的 `AgentEvent` 驱动（每次 commit 一批，挂载时先给 `snapshot`），不用 `viewState()` / `watch()`。durable 不发而属于 Loom 的状态——等待审批、dev-trace、follow-up 展示——走 Loom 通道：Loom `defineDoc` 配 `watchDoc`，加上 Loom 自有事件。`LoomAgentEvent` 不再作为传输层；它的 AG-UI 映射改到 durable 流 + Loom 通道上。
3. **存储后端 → SQLite。** 每库一个存储（例如 `<library>/.loom/loom.sqlite`），取代 `harness-sessions/` JSONL 目录；无需兼容旧格式。
4. **SQLite 驱动 → durable 用内置 `node:sqlite`**（`openNodeSqliteStorage`、`DatabaseSync`）。不做 facade，durable 也不用 `better-sqlite3`。`packages/core` 的检索库继续用 `better-sqlite3`，统一驱动不在本次范围。Electron 38.2.2 主进程是否暴露 `node:sqlite` 需验证一次。

待定：

5. **会话元数据**：title / archive 用 per-conversation `defineDoc`（可 watch）还是普通 entry？
6. **Specialist**：retrieve 和 create 都用归属 conversation，create agent 是否做成后台任务？
7. **Retarget / branch-before**：放弃，还是用 `fork(at)` 模拟？
8. **Telemetry**：基于事件 + hook 重建一个更粗的 trace（A），还是 fork durable（B），还是砍掉 dev-trace？

---

## 10. 迁移顺序

1. 先定 facade 与 UI 输入（§9 决策 1–2），再定义 durable 形态的 owner（`Harness` + `Registry` + Loom `defineDoc`）和 `@loom/agent` facade。
2. 升 pi-ai / chord 到 1.1.0，引入 pi-durable；先确认 SQLite 驱动（§9 决策 4），再跑通 `buildChatModels` + `Harness.open` + `submit` / `wait`。
3. 移植工具层：`pi-tools`、`read-image`（→ `createNodePhotonImages`，删旧代码）、`library-auto-memory`；把工具和提示做成 extension。
4. 用 durable 形态的 owner 取代 session manager；把 app 接到 view/event（最大一块）。
5. Specialist 迁到归属子代理。
6. 补 skills + prompt section + 会话元数据文档。
7. 重建 tests / evals；不写存储迁移，旧会话直接丢弃。
8. 决定 telemetry。

---

## 11. 风险

- **durable 是 Experimental**，API 随时变。锁版本，预期有反复。
- **Vendor 维护成本**：vendor 源码意味着 Loom 要合上游频繁改动，并自己维护这份 fork。
- **SQLite 驱动**：durable 的 Node 适配器依赖 `node:sqlite`，其在 Electron 38.2.2 中是否可用尚未验证；见 §9 决策 4。
- **不兼容（有意为之）**：旧的 `.loom/harness-sessions/` 会话直接忽略，不迁移。
- **行为漂移**：branch-before / retarget、会话 title / archive、上下文百分比显示在 durable 没有 1:1 原语。
- **telemetry 归属**：原先上游提供的生产者，迁移后要 Loom 自己承担。

---

## 12. 小结

- 上游把 harness 从 `packages/agent` 移到了 `pi-durable`；vendor 的 harness 冻结在 v0.85.1。
- durable 是重构，核心能力相同，不是功能升级。
- durable 以源码 vendor 进来，取代 `vendor-pi-agent/`；npm 依赖为 pi-ai、chord、photon、typebox、diff。
- 放弃向后兼容：旧会话存储、transcript 形状、附件旁路字段、projector 都不沿用。
- 范围以 durable 的特点为准；`packages/app` 也在范围内，不只是 `packages/agent`。
- 最大工作量是用 durable 形态的 owner 取代 session manager 并把 app 接到 durable 的 view/event，其次是 `specialist.ts` 与 telemetry 重建。
- 已定：薄的 `@loom/agent` 边界、`watchEvents` 驱动的 UI、SQLite 存储、durable 用内置 `node:sqlite`（§9）。其余 §9 项在动工前敲定。
