[English](./CLEANUP.md) | **简体中文**

# 待整理清单

> 记录已经失效、重复、名字仍停留在旧设计上，或纠缠到无法单独阅读的地方。这不是功能路线图（见 [TODO](./TODO.md)）；这里的每一条最终都应落到删除、重新接线、改名或拆分。
> 每条要写清：哪里不成形、为什么、涉及哪些符号、以及解开整理需要先做哪个决定。

---

## 1. Loom 的用词与 durable 对齐：`session` → `conversation`

**状态：** 计划，未开工；范围已定（标识符、文案、CSS 全改）。

durable 侧早就叫 conversation：`ConversationId`、`harness.conversation()`、`ConversationDoc`、`loom.conversation` 这个 doc kind、`conversation-metadata.ts`。从那一层往上，Loom 仍叫 session，同一个对象两个名字，而应用开发者先读到的是过时的那一个：`LoomSessionRecord`/`LoomSessionSummary`/`LoomSessionModel`（`session-dto.ts`）、`session-title.ts`、`ChatService.listSessions`、`IPC.loom:listSessions`、preload `window.loom.getSession`、`use-sessions.ts`、`session-chat.tsx`、`session-bar.tsx`、`ChatSessionContext`，以及 50 个 `.session-*` 选择器。

规模：`session` 在 `packages/agent/src` 出现 21 次、`packages/app/src` 622 次、`packages/app/tests` 217 次、`packages/app/e2e` 192 次。

**保留——只是同名，不是这个概念：**

- `McpSession`、`McpSessionFactory`、`openSdkSession`、`toolsFromMcpSession` —— MCP 传输层 session。
- `streamSimple` 选项里的 `sessionId` 与 durable `ProviderDoc.sessionId` —— provider 侧的会话身份，归 vendor。
- `workbench/graph-simulation.ts` 的 `sessionPositions` —— 进程内布局记忆。
- `.loom/harness-sessions/` —— 仅历史数据，保留目录名。

**已定：** 一次性全改，含用户可见文案和 CSS 选择器。随之要做两件事。

- **默认标题常量。** `DEFAULT_CONVERSATION_TITLE = "New conversation"` 会作为 `LoomConversationDoc.initial()` 的初值，新会话拿到新文案；已落库的文档仍保留 `"New session"`。Loom 判定“未命名”的两处（自动改标题的 `ChatService.prepareTurn()` 和 `ChatService` 的兼容取值 `ChatService.getSession()`）都要把两者都算作未命名，所以只导出一个 `isDefaultConversationTitle(title)`，`"New session"` 只出现在它内部。
- **文案。** `t.sessions.*` → `t.conversations.*`："New session" → "New conversation"、"Starting a session…" → "Starting a conversation…"、"Delete this session?" → "Delete this conversation?"；中文里指这段聊天的地方把“会话”改为“对话”。e2e 用 role/name 匹配这些字符串，须同一改。`DEFAULT_SESSION_TITLE` 不能脱离该 helper 单独上线。

**阶段** —— 每阶段结束时 `pnpm typecheck && pnpm test` 全绿，不改行为，`vendor-pi-*` 不动：

1. `@loom/agent`：`session-dto.ts` → `conversation-dto.ts`、`session-title.ts` → `conversation-title.ts`、`LoomSession{Record,Summary,Model}` → `LoomConversation*`、`DEFAULT_CONVERSATION_TITLE` 与 `isDefaultConversationTitle()`、`shared/ag-ui-messages.ts` 的 `liveMessagesForSession`/`agentSessionId`。消费方只通过 `durable.ts`/`index.ts` 的 re-export 受牵连。
2. IPC 契约一个提交内改完：通道名（`loom:listSessions` → `loom:listConversations` 等）、`IPC` 方法名、preload 接口、`ChatService` 方法（`listSessions` → `listConversations`、`setSessionName` → `setConversationTitle`、`archiveSession`/`unarchiveSession`/`deleteSession`/`setSessionModel`）、`ipcMain.handle` 注册、`shared/ipc.ts` 类型，以及 `chat-service.ts` 里写死的 `"New session"` 回退值。
3. Renderer：`use-sessions.ts` → `use-conversations.ts`、`session-chat.tsx`、`session-bar.tsx`、`chat-context.ts` 的 `ChatSessionContext`/`useChatSession`、`t.sessions` → `t.conversations`（中英双语文案），以及 `session.css`/`styles.css`/`dock.css` 里全部 50 个 `.session-*` 选择器。
4. 测试、e2e 与文档：`packages/app/tests`、`packages/app/e2e`（如 `agent.spec.ts` 的 role/name 查询）、`docs/agent/AGENT*.md` §1/§3/§6、`docs/PRODUCT*.md`（`sessions/` 树）、`docs/TODO*.md`。

**验收：** `grep -rn session packages/{agent,app}/src` 只剩上面的保留清单，不存在 `.session-` 选择器；类型检查、单测与 e2e 全绿。

---

## 规则

- 一处失效或纠缠一个条目，写清涉及符号。
- 记录结论，不记录讨论过程。
- 代码删掉就删条目；已完成的工作记到[归档](./archive/ARCHIVE.zh-CN.md)。
