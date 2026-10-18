[English](./CLEANUP.md) | **简体中文**

# 待整理清单

> 记录已经失效、重复、名字仍停留在旧设计上，或纠缠到无法单独阅读的地方。这不是功能路线图（见 [TODO](./TODO.md)）；这里的每一条最终都应落到删除、重新接线、改名或拆分。
> 每条要写清：哪里不成形、为什么、涉及哪些符号、以及解开整理需要先做哪个决定。

---

## 1. composer 图片直传已成死路径

**状态：** 死代码，等待"删除或重新接线"的决定。

图片早期以 base64 image 块随用户消息发送。`545fd9b feat(agent): send composer pictures as image parts` 加入，第二天 `cb6fb3b feat(agent): import composer attaches into the library as chips` 删掉了 renderer 的调用，改成"所有拖入文件导入素材库，变成 `asset_ref` chip"。管线留了下来。

**没有任何地方调用 `stageComposerImages`。** 已核对 `packages/`，不含 `packages/app/out/` 构建产物：

```
packages/app/src/preload/index.ts:69      暴露给 renderer
packages/app/src/main/index.ts:690        IPC handler
packages/app/src/main/composer-images.ts  暂存 Map + take
packages/agent/src/composer-image.ts      类型、解析、限制
```

**后果：**

- `takeComposerImages()` 恒返回 `[]`，`ag-ui-agent.ts:275` 与 `index.ts:747` 的 `images.length ? [...] : content` 永远走 else 分支。
- `LoomAgUiAgent.takeComposerImages` 和 `startAgentServer` 对应参数实际恒为 `undefined`/空。
- `IPC.stageComposerImages` 及其 preload、类型声明描述了一项应用并不具备的能力。
- `composer-image.ts` 的限制（最多 4 张、每张 8 MB、MIME 嗅探）与其测试覆盖的是一条走不到的路径。

**同一区域的命名债：** renderer 用图片名指代 chip——`chat-composer.tsx:320-321` 的 `actions.sendImageOnly` 和 `actions.hasAssets` 指的是 `asset_ref` chip，不是图片。

**需要决定：**

- *删除* —— 删掉 `composer-image.ts` 及其测试、`composer-images.ts`、`IPC.stageComposerImages` 通道、preload 方法与类型、`takeComposerImages` 整条参数链（`agent-server.ts` → `ag-ui-agent.ts`）、两处 `images` 分支，以及 `followUp` content 里的 `image` 部分。把 `sendImageOnly`/`hasAssets` 改成 chip 语义。
- *重新接线* —— 保留代码，补上缺失的 renderer 调用：`image/*` 的拖入与粘贴走 `stageComposerImages`，其余走 `importComposerFiles`。

未决之前代码保持原样：它是空转的，不产生问题。

---

## 2. 图片进入模型上下文只剩工具一条路

不是失效代码，但应与第 1 条放在一起记录的行为变化。`cb6fb3b` 之后，图片只有在工具返回时才会进入模型上下文：`read` 读图片文件（durable `tools/read.ts`），或 MCP 工具返回 `image` 内容块（`pi-tools.ts`）。用户拖进输入框的图片变成库内 chip，模型只看到路径，必须自己去读。

如果这是想要的产品行为，就清掉第 1 条的残留；如果不是，就把它接回来。

---

## 3. `LoomAgUiAgent.observe()` 是一个 290 行的巨型闭包

**状态：** 结构问题；拆分边界需要先确认，暂不动代码。

`ag-ui-agent.ts:47-334` 把整个 AG-UI ↔ durable 适配器放进一个 `new Observable(...)` 初始化函数：输入框消费与折叠、运行生命周期与取消、durable → AG-UI 事件翻译、partial 文本/推理拼装、工具与子会话 watcher、审批 activity、follow-up 的 inbox 边界簿记、submission 等待、收尾。所有阶段共用同一批可变闭包状态（`messageId`、`sentText`、`sentThinking`、`partialBlocks`、`knownTools`、`boundaries`、`boundaryWait`、`cancelled`、`finished`），任何一段都无法脱离其余部分单独阅读或测试。`run()` 与 `connectThread()` 的差别只有 `submit` 一个标志，它控制输入消费、`conversation.submit()` 调用和 teardown 时的 abort。

**拆分目标：**

- `createMessageSink(emit)` —— `messageId`/`sentText`/`sentThinking`、`partialBlocks`，以及 `close`/`textDelta`/`thinkingDelta`/`renderPartial`/`startTool`。
- `translateDurableEvent(...)` —— `onEvent` 的 switch：durable `AgentEvent`/`SnapshotEvent` → AG-UI 及 `loom.*` 自定义事件。只做协议映射，不含生命周期。
- `watchChildConversation(...)` —— `watchChild`、`restoreChild`、`watchedChildren` 及其返回的停止句柄。
- `submitTurn(...)` —— `takeComposerImages`/`takeComposerAssets`、`foldUserText`、标题、空输入检查、`conversation.submit`、`submission.wait`、`existingRequest`/`answerSeen` 处理。
- `drainFollowUps(...)` —— `placedInput`、`boundaries`、`boundaryWait` 改为显式传参，不再作为捕获的可变量。
- `finishRun(...)` —— `loom.history_changed`、`RUN_FINISHED`，以及 `finally` 收尾（`approvals.stop`、`stream.stop`、子会话停止、`complete`）。

**需要决定：** 拆分前确认上述边界，并确定 `translateDurableEvent` 是否独立成模块——它是唯一可以用合成事件序列做单测的部分。

---

## 4. Loom 的用词与 durable 对齐：`session` → `conversation`

**状态：** 计划，未开工；范围已定（标识符、文案、CSS 全改）。

durable 侧早就叫 conversation：`ConversationId`、`harness.conversation()`、`ConversationDoc`、`loom.conversation` 这个 doc kind、`conversation-metadata.ts`。从那一层往上，Loom 仍叫 session，同一个对象两个名字，而应用开发者先读到的是过时的那一个：`LoomSessionRecord`/`LoomSessionSummary`/`LoomSessionModel`（`session-dto.ts`）、`session-title.ts`、`LibraryAgentHost.listSessions`、`IPC.loom:listSessions`、preload `window.loom.getSession`、`use-sessions.ts`、`session-chat.tsx`、`session-bar.tsx`、`ChatSessionContext`，以及 50 个 `.session-*` 选择器。

规模：`session` 在 `packages/agent/src` 出现 21 次、`packages/app/src` 622 次、`packages/app/tests` 217 次、`packages/app/e2e` 192 次。

**保留——只是同名，不是这个概念：**

- `McpSession`、`McpSessionFactory`、`openSdkSession`、`toolsFromMcpSession` —— MCP 传输层 session。
- `streamSimple` 选项里的 `sessionId` 与 durable `ProviderDoc.sessionId` —— provider 侧的会话身份，归 vendor。
- `workbench/graph-simulation.ts` 的 `sessionPositions` —— 进程内布局记忆。
- `.loom/harness-sessions/` —— 只剩历史目录名，见 §5。

**已定：** 一次性全改，含用户可见文案和 CSS 选择器。随之要做两件事。

- **默认标题常量。** `DEFAULT_CONVERSATION_TITLE = "New conversation"` 会作为 `LoomConversationDoc.initial()` 的初值，新会话拿到新文案；已落库的文档仍保留 `"New session"`。Loom 判定“未命名”的两处（自动改标题的 `ag-ui-agent.ts:74` 和 `LibraryAgentHost` 的兼容取值 `library-agent-host.ts:149`）都要把两者都算作未命名，所以只导出一个 `isDefaultConversationTitle(title)`，`"New session"` 只出现在它内部。
- **文案。** `t.sessions.*` → `t.conversations.*`："New session" → "New conversation"、"Starting a session…" → "Starting a conversation…"、"Delete this session?" → "Delete this conversation?"；中文里指这段聊天的地方把“会话”改为“对话”。e2e 用 role/name 匹配这些字符串，须同一改。`DEFAULT_SESSION_TITLE` 不能脱离该 helper 单独上线。

**阶段** —— 每阶段结束时 `pnpm typecheck && pnpm test` 全绿，不改行为，`vendor-pi-*` 不动：

1. `@loom/agent`：`session-dto.ts` → `conversation-dto.ts`、`session-title.ts` → `conversation-title.ts`、`LoomSession{Record,Summary,Model}` → `LoomConversation*`、`DEFAULT_CONVERSATION_TITLE` 与 `isDefaultConversationTitle()`、`shared/ag-ui-messages.ts` 的 `liveMessagesForSession`/`agentSessionId`。消费方只通过 `durable.ts`/`index.ts` 的 re-export 受牵连。
2. IPC 契约一个提交内改完：通道名（`loom:listSessions` → `loom:listConversations` 等）、`IPC` 方法名、preload 接口、`LibraryAgentHost` 方法（`listSessions` → `listConversations`、`setSessionName` → `setConversationTitle`、`archiveSession`/`unarchiveSession`/`deleteSession`/`setSessionModel`）、`ipcMain.handle` 注册、`shared/ipc.ts` 类型，以及 `library-agent-host.ts` 里写死的 `"New session"` 回退值。
3. Renderer：`use-sessions.ts` → `use-conversations.ts`、`session-chat.tsx`、`session-bar.tsx`、`chat-context.ts` 的 `ChatSessionContext`/`useChatSession`、`t.sessions` → `t.conversations`（中英双语文案），以及 `session.css`/`styles.css`/`dock.css` 里全部 50 个 `.session-*` 选择器。
4. 测试、e2e 与文档：`packages/app/tests`、`packages/app/e2e`（如 `agent.spec.ts` 的 role/name 查询）、`docs/agent/AGENT*.md` §1/§3/§6、`docs/PRODUCT*.md`（`sessions/` 树）、`docs/TODO*.md`。

**验收：** `grep -rn session packages/{agent,app}/src` 只剩上面的保留清单，不存在 `.session-` 选择器；类型检查、单测与 e2e 全绿。

---

## 5. `.loom/harness-sessions/` 已经没有运行时对应物

**状态：** 已定，未施工；不改行为。

durable 之前的会话管理器已不存在，也没有取代它的读取方。`packages/*/src` 中完全不提这个目录，而忽略规则并不靠这个名字：`isIgnoredPath()` 通过 `library-paths.ts:39-56` 的前缀判断覆盖整个 `.loom/`。剩下四处提及，只有两处携带信息。

- `packages/agent/vendor-tests/library-agent.test.ts:33-53` —— 往目录里写非法 JSONL，再断言会话列表仍为空、文件在打开与关闭后逐字节不变。**保留。** 它是唯一一道守卫：打开素材库既不读取也不删除未知的 `.loom/` 数据。
- `packages/core/tests/library-paths.test.ts:24-25` —— 断言 `.loom/sessions/` 和 `.loom/harness-sessions/` 被忽略。**重复：** 第 23 行已经用 `.loom/metadata.db` 覆盖同一条规则。
- `docs/agent/AGENT.md:65` / `.zh-CN` —— 唯一说明该目录是什么的地方。保留这个事实，但把它写成规则而不是一次性特例：`.loom/` 下的旧目录一律忽略，不读取也不删除。

**改动：** 删除 `library-paths.test.ts:24-25`，把 AGENT 那行改写为上述通用规则，`docs/archive/` 不动。

---

## 规则

- 一处失效或纠缠一个条目，写清涉及符号。
- 记录结论，不记录讨论过程。
- 代码删掉就删条目；已完成的工作记到[归档](./archive/ARCHIVE.zh-CN.md)。
