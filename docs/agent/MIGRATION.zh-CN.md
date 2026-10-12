[English](./MIGRATION.md) | **简体中文**

# Agent Core 迁移 — pi `packages/agent` harness → `pi-durable`

> 评估把当前 vendor 的 Pi harness 换成 `@earendil-works/pi-durable`。当前架构见 [AGENT](./AGENT.zh-CN.md)。
> 本文记录范围、逐文件映射、能力对照、telemetry，以及待定决策。本文假设完全向后不兼容：旧会话文件直接丢弃。迁移落地后同步更新 [AGENT](./AGENT.zh-CN.md)。
>
> **源码基线：** 跟随上游 `main`，不是 `v1.1.0` tag。下文的图像处理、嵌套工具、结构化输出与 code mode 均在该 tag 之后加入；`UPSTREAM` 记录实际同步的 commit，npm 依赖需要据此核对。

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

注：上面的"能力大体相同"是读 1.1.0 源码得出的，尚未实测。durable 的压缩策略（`DEFAULT_COMPACTION_POLICY`）与旧 harness 不同，这份等价性应由现有 eval 验证，见 §10 第 7 步。

---

## 3. 范围：以 durable 的特点为准，不局限在 `@loom/agent`

迁移应顺着 durable 的原语走——conversation、entry、document、task、submission、registry、watch/view——而不是把它们包成旧的 `HarnessSessionManager` / lane API。因此 `packages/app` 也在范围内。

具体含义：

- **用 owner，不用 lane。** 用 durable 形态的 owner 取代 `HarnessSessionManager`：每个打开的库一个 `Harness` 加一个 `Registry`，对外暴露 `Conversation` 句柄。不再有 `lane`、`accept`、`drive`，也不手写 recovery。
- **App 状态用 document。** 会话 title、archive 标记以及其他 Loom per-conversation 状态改成 `defineDoc`，在 commit 中读写，而不是 session 旁路值。
- **Busy 用 inbox。** steer / follow-up / reject 用 `submit(..., { whenBusy })` 和 `pi.inbox`，不再手写 follow-up map。
- **Specialist 用归属子代理。** `run_retrieve_agent` / `run_create_agent` 改成归属 conversation（`ownership: { kind: "task", taskId }`），不再是每次调用一个内存 harness。retrieve 与 create 都不标 `background`（§9 决策 6），所以 Stop 能中断它们、生成期间会话算 busy。
- **工具与提示用 registry。** Loom 工具、系统提示、skills/memory 注入、权限门禁都做成一个 extension（tools、sections、hooks、wraps），装进 registry。
- **UI 消费已提交状态。** App 读 `conversation.viewState()` / `watch()` 和/或 `watchEvents()`。`LoomAgUiAgent` 仍是 AG-UI 协议边界，但输入从 `LoomAgentEvent` + manager 方法变成 durable 的 view/event。
- **每库一个 SQLite 存储**（例如 `<library>/.loom/loom.sqlite`），取代 `harness-sessions/` JSONL 目录。

边界偏好：AG-UI 仍是前端协议，`packages/app` 优先使用薄的 `@loom/agent` facade，而不是直接 import `pi-durable` 类型。结论见 §9 决策 1（已定：保留薄 facade）。

`packages/agent` 之外会牵动的文件：会话列表（→ `scanConversations` + Loom document）、renderer 的会话/上下文面板、dev-trace（§8），以及所有依赖旧 session manager 行为的 `packages/app` 调用点。规模不小：`harness-session-manager.ts` 有 1105 行，被 14 个文件引用，其中 app 侧主进程的 `ag-ui-agent.ts`（512 行）、`agent-server.ts`、`index.ts` 都要跟着重写——§5 单列了一张 app 侧映射表。

**完全不兼容。** 旧的 `<library>/.loom/harness-sessions/` JSONL、存储的 transcript 形状、`attachments` 旁路字段、`loom_user_stop` entry projector 全部丢弃。一个库只保留一个 durable 存储；旧会话文件直接忽略，不做迁移。按最干净的设计做，不为存量写读取器。

---

## 4. 依赖变化

| 依赖 | 现在 | 迁移后 | 说明 |
|---|---|---|---|
| `@earendil-works/pi-ai` | 0.85.1 | 1.1.0 | `createModels` / `createProvider` 移到 `/models`；核对 API factory 路径 |
| `@earendil-works/chord` | 0.85.1 | 1.1.0 | `BACKGROUND_CONTEXT`、`Context` 从 `@earendil-works/chord/context` 取 |
| `@earendil-works/pi-durable` | — | vendor 源码 | 新 harness，vendor 到 `vendor-pi-durable/src`；子路径用 `#vendor/pi-durable/*` 映射；见下方 Vendoring |
| `@earendil-works/pi-codemode` | — | vendor 源码（`workspace:*`） | `vendor-pi-codemode/src`，与 durable 从上游 `main` 同一 commit 同步；只有它的 `quickjs-wasi` 依赖仍走 npm |
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
├── vendor-pi-durable/
│   ├── UPSTREAM        # repo: .../pi.git, directory: packages/durable, ref, commit
│   ├── sync.sh         # 转发 sync.mjs；一次同步两份 vendor
│   └── src/            # 纯净上游源码
└── vendor-pi-codemode/
    ├── package.json    # 私有 workspace；保留上游包名/exports
    ├── UPSTREAM        # directory: packages/codemode；相同 ref 与 commit
    └── src/            # 纯净上游源码
```

`sync.sh` 用 `rsync --delete` 镜像 `packages/durable/src/`（排除 `**/*.test.ts`、`**/testing/**`、`benchmark/**`），把 ref + commit 写进 `UPSTREAM`，默认 ref 用 `main`。`sync.sh` 转发到 `sync.mjs`，后者从同一次 clone 镜像 `packages/durable/src` 与 `packages/codemode/src`，分别记录来源目录与相同 commit，并在原生 Windows 上提供等价的文件系统镜像。Loom 自有的 codemode 包/构建配置留在 `src/` 外，不受同步影响；durable 的 `@earendil-works/pi-codemode` import 直接解析到私有 workspace，无需改写 vendor 源码。注意 `**/testing/**` 被排除，所以 durable 的 `./testing` 导出（storage 一致性测试套件）在 vendor 里不可用；若 Loom 想复用那套 conformance 用例，要么单独拷贝，要么直接依赖 npm 上的 `@earendil-works/pi-durable`。

入口：把 Loom 用到的 durable 子路径通过 `imports` / tsconfig 映射：

- `#vendor/pi-durable` → `vendor-pi-durable/src/index.ts`
- `#vendor/pi-durable/tools` → `vendor-pi-durable/src/tools/index.ts`
- `#vendor/pi-durable/codemode` → `vendor-pi-durable/src/codemode/index.ts`
- `#vendor/pi-durable/env/node` → `vendor-pi-durable/src/env/node.ts`
- `#vendor/pi-durable/images/node` → `vendor-pi-durable/src/images/node.ts`
- `#vendor/pi-durable/storage/sqlite/node` → `vendor-pi-durable/src/storage/sqlite/node.ts`
- `#vendor/pi-durable/storage/jsonl/node` → `vendor-pi-durable/src/storage/jsonl/node.ts`

应用代码仍然只 import `@loom/agent`；保持单一边界（`pi-adapter.ts` 或新的 `durable-adapter.ts`）。

外部依赖仍走 npm，并与 durable 版本对齐：`@earendil-works/chord` 1.1.0、`@earendil-works/pi-ai` 1.1.0、`typebox`、`diff`，以及新增 `@silvia-odwyer/photon`（durable 的图像处理用它，不是 `photon-node`）。pi-agent-core 不再需要。

vendor 分支规则不变：`vendor-clean` 存纯净上游，`main` 放本地改动，只在 `vendor-clean` 上 sync，Loom 自己的新增放到 `src/`，不要放进 `vendor-pi-durable/src/`（下次 sync 会被删）。

因为 durable 是 Experimental 且改动频繁，预期合并会比旧 harness 更折腾。telemetry 不靠改 vendor：以后走 extension 外挂（§8），vendor 保持纯净上游。

---

## 5. 逐文件映射

| 文件 | 旧依赖 | 新做法 |
|---|---|---|
| `pi-adapter.ts` | `convertToLlm`、`AgentMessage` | `buildChatModels` 已改用 pi-ai 1.1.0 `/models`；lazy OpenAI-completions API 路径不变。已移除 `convertToLlm` / `toProviderMessages`：durable 的 entry 直接带 `model: Message[]`，附件折叠改到 submit 时做 |
| `pi-tools.ts` | `AgentHarnessTool`、`createReadTool({imageProcessor})`、`createBashTool({prepare})`、`ExecutionToolContext` | 改用 durable `createCodingTools()` / `createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool`；`toHarnessTool` 重写为 `defineTool`（`execute(args, api, context)` → `{ output, details }`）。bash `prepare` 变为 `BashExecution {command, cwd, env, inheritEnv}` + `api` + `context`，适配 `prepareSandboxedBash`。`ExecutionToolContext` / `setCwd` 消失：env 由 `HarnessOptions.env` 按 conversation `cwd` 每次构建 |
| `read-image.ts` | `ReadImageProcessor` / `ReadImageProcessorResult` | 换成 durable `ImageProcessor.prepare(bytes, mimeType, limits) → PreparedImage`；直接用 `createNodePhotonImages()` 并删掉本文件 |
| `library-skills.ts` | `loadSkills`、`formatSkillsForSystemPrompt` | 无等价导出；在 durable `ExecutionEnv` 上自研，或移植 coding-agent 的 `core/skills.ts`。目录注入改成 prompt `section` |
| `library-auto-memory.ts` | `AgentHarnessTool`、`ExecutionToolContext` | 仅类型替换为 `defineTool` + `ToolExecutionApi`。注入改成 `section` / `instructions` |
| `agent-instructions.ts` | — | 映射到 per-conversation `instructions`（渲染为 `instructions` section） |
| `session-title.ts` | — | 纯文本工具（`titleFromUserText`），无 harness 依赖；title 的**存储**改由 Loom `defineDoc` 承担，见 §9 决策 5 |
| `attachments.ts` / `composer-asset.ts` | 经 `convertToLlm` 折入 | 旁路字段本身不再需要；折进 `content` 的时机从 `convertToLlm` 挪到 `submit` 之前 |
| `tool-permission.ts` | `hooks.on("before_tool")` | `AGENT_PERMISSION_LEVELS` / `ToolGateDecision` 业务逻辑原样保留，挂载点改成 `hook(ToolTask, { beforeTool })`；等待态发布见 §6 |
| `specialist.ts` | `AgentHarness` + `MemorySessionRepo` | 去掉"每个 specialist 一个内存 harness"；改用 durable 归属子代理（§9 决策 6：retrieve 与 create 都归属，都不标 `background`）。**注意 Tx 与 Conversation 是两级 API，别混用**：工具内部走 `Tx`——`api.commit(tx => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }))`，随后 `api.conversation(childId)` 拿句柄；Harness 层才有 `harness.createConversation({ ownership }, context)` 和 `Conversation.fork(at, { ownership }, context)` |
| `harness-session-manager.ts` | `JsonlSessionRepo`、`AgentHarness.create`、`lane.accept/drive/followUp/abort/resume`、`hooks.on`、`events.on`、`estimateContextTokens`、`laneConfig/laneState/value` | 整体重写——见 §6 |
| `run-trace.ts` / `trace-io.ts` | `withTelemetryContext`、pi-telemetry span | 本次迁移不做：先摘除对 `withTelemetryContext` / pi-telemetry 的依赖，保留 `LoomTraceSpan` 类型与 dev-trace UI 不动；以后基于 durable extension 重建——见 §8 |
| tests / evals | `AgentHarness`、`JsonlSessionRepo`、`NodeExecutionEnv`、`estimateTokens`、`findCutPoint`、`span-io` | 逐个重写；`BACKGROUND_CONTEXT` 改从 `@earendil-works/chord/context` 取 |

### App 侧（`packages/app`）映射

会话 manager 的替换不会止步于 `packages/agent`。当前引用 `HarnessSessionManager` 的 app 侧文件：

| 文件 | 旧依赖 | 新做法 |
|---|---|---|
| `src/main/ag-ui-agent.ts` | `HarnessSessionManager` 方法 + `LoomAgentEvent` | 改为消费 `watchEvents(harness, conversationId)` 的 `AgentEvent` 流加 Loom 通道（§9 决策 2）；AG-UI 映射重写；持有 durable `Conversation` 句柄 |
| `src/main/agent-server.ts` | manager 路由 | 同上；对外 RPC 形状不变，内部换成 durable 句柄 |
| `src/main/index.ts` | manager 生命周期 | 改成 per-library `Harness` + `Registry` 的持有与关闭 |
| `tests/ag-ui-agent.test.ts` | manager 桩 | 用 memory storage + `createRegistry()` 重建桩 |
| `evals/*`、`scripts/try-agent.ts`、`tests/*` | `AgentHarness`、`JsonlSessionRepo` | 见上表最后一行 |

---

## 6. Session manager：替换，而不是移植

旧 `HarnessSessionManager` 把 lane、session、recovery、事件翻译都揽在自己身上。durable 把这些职责拆给 `Harness`、`Conversation`、task 和 view；durable 形态的 owner 应该委派给它们，而不是重新实现。旧 API 到 durable 的对照清单：

| 现在 | durable |
|---|---|
| `JsonlSessionRepo({ fileSystem, sessionsRoot })` | `openNodeSqliteStorage(file)`（推荐；JSONL 全量驻内存）或 `openNodeJsonlStorage(dir)`——Node SQLite 适配器用 `node:sqlite`，见 §9 |
| `AgentHarness.create({ session, models, model, tools, toolContext, systemPrompt, toProviderMessages, compaction, ... })` | `Harness.open(storage, { models, registry, settings, env }, context)`——`context` 是必填第三参，容易漏 |
| `harness.lane("main")` + `lane.accept({kind:"prompt"})` + `lane.drive()` | `harness.root()` / `harness.conversation(id)` → `conversation.submit({type:"input", content, requestId})` → `submission.wait()` |
| `lane.abort`、`lane.resume`、手写 recovery | `conversation.abort()`、`harness.resume()`、带 `requestId` 的幂等 `submit` |
| `lane.followUp` / steering | `submit(..., { whenBusy: "steer" \| "followUp" \| "reject" })` |
| `lane.navigateTree` / `repo.fork({ scope:"branch", position:"before" })` | `Conversation.fork(at: EntryId, options: ConversationCreateOptions, context)`（`options = { ownership, agent?, init? }`）；采用 fork-and-switch：从目标 user 消息之前的上下文 fork，切换到新会话，并归档/隐藏旧会话。旧会话记录必须保留，因为 fork 通过 parent 关系继承历史。`conversation.context(ctx, { at })` 可先预览 fork 点的上下文而不建分支 |
| `session.setName` / `setValue(ARCHIVED)` | 无 title/archive 概念；用 per-conversation `defineDoc` 单独存储，不进 entry（§9 决策 5） |
| `session.getValue(laneConfig/laneState)` | `conversation.configure()` / `conversation.agent()` / `harness.inspect()` |
| session 列表 | `Storage.scanConversations({ ownerConversationId?, order? })`；无 `cwd` 过滤，"一库一组"需自建归属映射 |
| `hooks.on("before_tool", …)` | `defineExtension({ hooks: [hook(ToolTask, { beforeTool: call => … })] })`；`call.id/name/arguments` 可用；异步等用户审批仍可行 |
| `events.on("message_update" / "thinking_*" / "tool_*" / "usage" / "compaction_*" / "retry_*")` | `watchEvents(harness, conversationId)` 的 `AgentEvent`（`message_update` delta、`tool_execution_*`、`auto_retry_*`、`compaction_*`、`usage_changed`），或 `conversation.watch()` / `viewState()`；重写 `LoomAgentEvent` 翻译 |
| `estimateContextTokens` / `calculateContextTokens` | 不导出；用 `harness.usage()` / `pi.usage`，或砍掉上下文百分比显示 |
| `entryProjectors: { loom_user_stop }` | 自定义 entry kind + `entry.model`，或 generation hook |

**等待审批**在 durable 里没有事件。`beforeTool` 可以 await，所以门禁机制成立；等待状态由 Loom 发布——一个 Loom `defineDoc`（等待中的审批）用 `watchDoc` 观察，加一个 Loom 自有事件——因为 durable 的 `watchEvents` 流不能注入。

三个 `HarnessOptions` 细节值得单独记住：

- **`env` 是工厂，不是实例。** 签名是 `(target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<...>`，其中 `EnvTarget = { conversationId, cwd?, read }`。用 `new NodeExecutionEnv({ cwd: target.cwd })` 按需构造即可，正好替掉旧的 `setCwd` 模式。
- **`conversationCreated` 是归属映射的落点。** `HarnessOptions.conversationCreated?: (tx, conversation) => void | Promise<void>` 在每个创建/分叉 conversation 的 commit 里跑（早于 `init`），是初始化 per-conversation Loom `defineDoc`、以及建立上面"Session 列表"一行所缺的"一库一组"归属映射的地方。
- **`registry` 是必填项且与 Harness 实例绑定。** `createRegistry()` 产出的 registry 必须包含内置任务（否则 `Harness.open` 直接抛错），且一个 `Harness` 打开时就固定了它的 registry 实例；热替换的粒度是 registry 内部的 `install()` / `uninstall()`，换 registry 需重开 Harness。

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
| 可热替换注册表 | 无 | 有（extension/section/hook/wrap），但粒度限于 registry 内部：`Registry.install()` / `uninstall()` 可热装热卸扩展，`Harness` 打开时即绑定传入的 registry，换 registry 需重开 Harness |
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

**范围：本次迁移不做 telemetry，以后做；做法定为基于 durable 扩展机制的外挂，不 fork durable。** 迁移期间 dev-trace 不产出 span（UI 和 `LoomTraceSpan` 类型保留）。

以后的做法：一个 telemetry extension（`hook(GenerationTask, …)` + `hook(ToolTask, …)`），每个 conversation 一个 `watchEvents` 观察器，加一个 Loom 自有的可手动 start/end 的 `TelemetryContext`，用 `conversationId` / `taskId` / `callId` 维护 span 树。只要 span 名/属性对齐，`LoomTraceSpan` 和 dev-trace UI 无需改动。

需要重新拥有 `AI_TELEMETRY_SCHEMA` / `HARNESS_TELEMETRY_SCHEMA`（在旧 vendor 里，会随 vendor 消失；`pi-telemetry` 仍提供 `defineTelemetrySchema` / `createTypedSpanStarter`），并放弃 `withTelemetryContext`——durable 不从 chord `Context` 读 telemetry。

---

## 9. 决策

已定：

1. **Facade 还是直接用 durable 类型 → 薄的 `@loom/agent`。** 转发 durable 的通用类型与句柄（`Harness`、`Conversation`、`EntryRecord`、`ConversationView`、`watchEvents`、`defineTool` / `defineExtension` / `section` / `hook` / `defineDoc`）；只包装 Loom 特有的装配与策略——工具集、提示 section、skills/memory、权限门禁、Loom 文档、每库一个 `Harness` 的生命周期。`packages/app` 的 main 持 durable 句柄；IPC 与 renderer 仍走 Loom DTO，让上游 churn 不穿过进程边界。判定：通用运行时与活句柄转发，Loom 特有与跨进程包装。
2. **UI 输入 → durable `watchEvents`。** AG-UI 由 durable 的 `AgentEvent` 驱动（每次 commit 一批，挂载时先给 `snapshot`），不用 `viewState()` / `watch()` 作为主通道。理由：事件流是增量，跨进程只传增量可以省掉全量快照的序列化，而 `LoomAgentEvent` 的翻译逻辑本来就在事件粒度上。代价是挂载/重连时要自行重建完整视图。若这条路径变得太绕，退路是用 `viewState()`（返回 `AttachedReplicatedState<ConversationView>` 快照）兜住挂载态、`watchEvents` 拿增量——两者不冲突，可随时切换。durable 不发而属于 Loom 的状态——等待审批、dev-trace、follow-up 展示——走 Loom 通道：Loom `defineDoc` 配 `watchDoc`，加上 Loom 自有事件。`LoomAgentEvent` 不再作为传输层；它的 AG-UI 映射改到 durable 流 + Loom 通道上。
3. **存储后端 → SQLite。** 每库一个存储（例如 `<library>/.loom/loom.sqlite`），取代 `harness-sessions/` JSONL 目录；无需兼容旧格式。
4. **SQLite 驱动 → durable 用内置 `node:sqlite`**（`openNodeSqliteStorage`、`DatabaseSync`）。不做 facade，durable 也不用 `better-sqlite3`。`packages/core` 的检索库继续用 `better-sqlite3`，统一驱动不在本次范围。

   **前置条件已在 macOS 验证：** `pnpm --filter @loom/app check:node-sqlite` 启动真实 Electron 38.2.2 主进程（Node 22.19.0），`node:sqlite` 读写/重开通过。WAL 下第一进程持有读快照时，第二个 Electron 进程可提交写入；同时写事务由 SQLite 锁互斥。这**不代表**多个 durable owner 可安全共享存储：durable 没有跨进程 session 锁，每库存储只能有一个活跃 Harness owner。Windows 仍需在实机运行同一检查。

5. **会话元数据 → per-conversation `defineDoc`，单独存储，不进 entry。** title / archive 等 Loom per-conversation 状态是元数据，不属于 transcript：不写 entry，不参与模型上下文与 compaction，也不随历史回放。读写在 commit 里进行，可用 `watchDoc` 观察；在 `HarnessOptions.conversationCreated` 里初始化。使用 `fork: "current"` 拷贝当前标题，创建 hook 再追加 `（分支）` 后缀并重置 `archived: false`；不改变来源会话。嵌套 fork 每次追加一次后缀。会话列表用 `scanConversations` 拿 conversation，再按 id 读 doc 拼出 title / archive。
6. **Specialist → 归属 conversation，且不做后台任务。** retrieve 和 create 都用归属子代理（`ownership: { kind: "task", taskId }`），取代每次调用一个内存 harness；两者都不标 `background`，以保持现状：Stop 会中断正在跑的 specialist，生成期间会话也算 busy。
7. **Telemetry → 本次不做，以后基于 durable extension 外挂（§8）。** 不 fork durable、不改 vendor。迁移期间 dev-trace 无 span 输出。

已定：

8. **Retarget / branch-before → fork-and-switch，旧会话归档隐藏。** 从目标 user 消息之前的上下文 fork，切换到新会话，并归档/隐藏原会话；不物理删除原会话记录，因为 fork 通过 parent 关系继承历史。

---

## 10. 迁移顺序

**第 1 步已完成：** durable 与 codemode 均从上游 `main` commit `4270522473e677ddba7b093caa0064a3df51d459` vendor，来源一致，已更新 imports/export 边界、依赖与独立检查。重复同步内容一致。完整 vendor 类型检查/构建、10 项源码测试与编译后 JS/worker 冒烟测试通过；覆盖 memory/JSONL/SQLite、工具/事件、嵌套结构化输出、Photon、沙箱隔离、确定性运行与 durable code mode。Loom 旧测试/eval 与 app 仍引用已移除的 harness，尚不能运行。

**第 2 步已完成：** macOS 上 Electron SQLite 前置条件通过；`buildChatModels` 已改用 `/models`，不再 import 旧 harness。新增两项独立测试，验证 endpoint/auth/model 配置与 SQLite 上的 OpenAI SSE 请求，包括重开的模型上下文、provider identity 与 request 去重。`pnpm --filter @loom/agent try:durable` 也已对真实 DeepSeek endpoint 跑通 echo 工具与 SQLite 重开。可通过 `LOOM_CHAT_BASE_URL` / `LOOM_CHAT_MODEL` / `LOOM_CHAT_API_KEY` 覆盖冒烟 endpoint（默认 DeepSeek，使用 `DEEPSEEK_API_KEY`）。app owner 与 UI 仍未动，旧 `toProviderMessages` 调用点留待迁移。

**第 3 步已完成：** 新增 `LibraryAgent`（每库一个 SQLite Harness + Registry，委派 durable 恢复/关闭）、`LoomConversationDoc` 与列表/改名/归档操作。`@loom/agent/durable` 通过 `src/durable.ts` 转发通用 API 与 Loom owner，vendor import 仍只在 `durable-adapter.ts`。原生与 raw fork 都追加 `（分支）`、重置归档，默认列表排除 owned conversation。同进程通过 canonical path 防止重复打开；跨进程唯一 owner 仍由 app 生命周期保证，未新增跨进程锁。新增 10 项 owner 测试，总计 22 项独立源码测试与编译后 worker 检查通过。app、旧 root facade 与业务工具尚未接入，fork-and-switch 的来源归档留给 app 操作。

**第 4 步已完成：** `pi-tools` 改为 durable tools，无 toolContext/setCwd；bash 通过 durable `prepare(execution, api, context)` 调用现有进程沙箱。`toDurableTool` 用 `defineTool`，转发输出/取消并校验 JSON details，外部副作用 `replay: "unsafe"`。删除 `read-image.ts`，read 使用上游 Photon worker。`createLibraryExtension` 装配 workspace/Loom/auto-memory 工具与 preamble/memory sections；`LoomMemoryDoc` 保存创建时快照，fork/重开保留，更新文件只影响新会话。调用方需将装配的 `conversationCreated` 传给 `LibraryAgent.open`；用户 instructions 用原生 `agent.instructions`。新增 9 项工具层测试，总计 31 项独立源码测试通过，包含真实沙箱写入/网络限制。权限门禁、specialist、skills 与 app 仍留待后续，不用此扩展替代尚未迁移的 permission hook。

**第 5–8 步已实现，能力验收仍有未闭环项：** app 使用 `LibraryAgentHost`、原生 submission/inbox、metadata document 和 AG-UI `watchEvents`。测试覆盖 specialist ownership、隔离、并行、approve/reject/Stop 和 SQLite 重开。Skills 使用 durable `ExecutionEnv` 与目录 section。旧 tests/evals 改为原生 durable API，删除的 workspace/image/branch/gate 旧测试由新 vendor/app 测试覆盖。Root facade 暴露原生句柄和 Loom DTO，不提供旧 manager 兼容 API。

流式修复：处理 `message_start` 及所有 partial change（完整消息/内容块和 delta）；admission 前快照保留 optimistic user，避免 history/live 合并隐藏增量。Electron 验证了子审批（包含等待时刷新恢复）和结束前显示文字，真实 DeepSeek 也通过。CopilotChat 显式传入 `threadId` 后使用原生重连，取代手动抢占线程。`DurableAgentRunner` 用原生 durable connect/stop 路由取代 CopilotKit 内存运行历史，断开传输不取消工作。SIGKILL/重开验收恢复同一个等待审批的子代理，不重复请求模型。临时调试代码已移除。

验证：全仓库类型检查通过；单元测试通过（core 133 + 1 跳过、agent 60、app 189），另外 34 项 vendor 独立测试和 1 项编译 worker 测试通过。Electron 标准 7 项通过，可选 live 1 项通过。Live 流式断言只统计 `/run`，排除空闲 connect 的结束事件。Core 旧测试对齐显式关系 links 和沙箱 fail-closed 初始化，Markdown 预期补上缓存 size 后缀。Live 压缩保留锚点回忆，cache 评测可运行；严格 live 工具金标为 3/4，数值见 [EVALS](./EVALS.zh-CN.md)。Windows 运行时、其他崩溃点（流式生成/正在执行外部工具）的覆盖以及工具金标差距待完成；telemetry 延后，context 百分比暂不显示。

1. **先改 vendor 源码与脚本。** 用 pi-durable 替换 `vendor-pi-agent/`，更新 vendor 来源/同步脚本（`vendor:sync`）及 `packages/agent` 的依赖、导出和构建/测试脚本；先确保 vendor 可重复同步、编译和独立测试，不接 app。
2. 升 pi-ai / chord 到 1.1.0 并引入 pi-durable；**先验证 Electron 主进程的 `node:sqlite`（§9 决策 4 前置条件）**，再跑通最小链路：`buildChatModels` + `createRegistry()` + `Harness.open(storage, options, context)` + `submit` / `wait`。
3. 定 facade 与 UI 输入（§9 决策 1–2），实现 durable 形态的 owner（`Harness` + `Registry` + Loom `defineDoc`）和 `@loom/agent` facade。
4. 移植工具层：`pi-tools`、`read-image`（→ `createNodePhotonImages`，删旧代码）、`library-auto-memory`；把工具和提示做成 extension。
5. 用 durable 形态的 owner 取代 session manager；把 app 接到 view/event（最大一块）。
6. Specialist 迁到归属子代理（§9 决策 6）。
7. 补 skills + prompt section + 会话元数据文档。
8. 重建 tests / evals；不写存储迁移，旧会话直接丢弃。重建后先跑 `compaction-rate` / `prompt-cache-hit` / `agent-tools` / `compaction-e2e` 拿到与旧版可比的数值基线，用它们判定 §2 的"能力等价"是否成立，而不是只看 API 齐不齐。
9. （后续，不在本次范围）按 §8 用 extension 重建 telemetry。

---

## 11. 风险

- **durable 是 Experimental**，API 随时变。跟随上游 `main`，记录每次同步的 commit，预期有反复。
- **Vendor 维护成本**：vendor 源码意味着 Loom 要合上游频繁改动，并自己维护这份 fork。
- **SQLite 驱动**：已在 macOS Electron 38.2.2 验证（§9 决策 4），Windows 待实机验证。SQLite WAL 并发不等于跨进程 durable 协调；每库存储保持单一活跃 Harness owner。
- **不兼容（有意为之）**：旧的 `.loom/harness-sessions/` 会话直接忽略，不迁移。
- **行为漂移**：branch-before / retarget 改为 fork-and-switch（创建新会话而非原地切换；旧会话归档隐藏但保留为历史来源）；会话 title / archive、上下文百分比显示在 durable 没有 1:1 原语。
- **telemetry 归属 / 空窗**：原先上游提供的生产者，迁移后要 Loom 自己承担；本次不做，期间 dev-trace 没有数据，排查问题少一个手段。

---

## 12. 小结

- 上游把 harness 从 `packages/agent` 移到了 `pi-durable`；vendor 的 harness 冻结在 v0.85.1。
- durable 是重构，核心能力相同，不是功能升级。
- durable 与 codemode 从上游 `main` 同一 commit 源码级 vendor，取代 `vendor-pi-agent/`；npm 依赖为 pi-ai、chord、photon、typebox、diff、quickjs-wasi。
- "durable 与旧 harness 能力相当"目前是读源码的判断，需由现有 eval 在重建后验证（§10 第 8 步）。
- 放弃向后兼容：旧会话存储、transcript 形状、附件旁路字段、projector 都不沿用。
- 范围以 durable 的特点为准；`packages/app` 也在范围内，不只是 `packages/agent`。
- 最大工作量是用 durable 形态的 owner 取代 session manager（旧实现 1105 行、14 处引用）并把 app 接到 durable 的 view/event——`packages/app` 主进程三个文件都在内，其次是 `specialist.ts`。telemetry 不在本次范围。
- 已定：薄的 `@loom/agent` 边界、`watchEvents` 驱动的 UI、SQLite 存储、durable 用内置 `node:sqlite`、telemetry 本次不做且以后走 extension（§9）。会话元数据用单独的 `defineDoc`（§9 决策 5）；specialist 都走归属 conversation 且不做后台任务（§9 决策 6）；branch-before 用 fork-and-switch，并归档隐藏旧会话（§9 决策 8）。
