[简体中文](./CLEANUP.zh-CN.md) | **English**

# Cleanup backlog

> Places that are dead, duplicated, named after a design that no longer holds, or entangled so that no part can be read alone. This is not a feature roadmap (see [TODO](./TODO.md)); every entry here should end in deletion, reconnection, a renamed concept, or a decomposition.
> An entry needs: what is out of shape, why, the concrete symbols involved, and the decision that unblocks cleanup.

---

## 1. Align Loom's vocabulary with durable: `session` → `conversation`

**Status:** plan, not started; scope decided (identifiers, copy and CSS all move).

Durable already says conversation: `ConversationId`, `harness.conversation()`, `ConversationDoc`, the `loom.conversation` doc kind, `conversation-metadata.ts`. Above that line Loom still says `session`, so one object has two names and the stale one is the one app developers read first: `LoomSessionRecord`/`LoomSessionSummary`/`LoomSessionModel` (`session-dto.ts`), `session-title.ts`, `ChatService.listSessions`, `IPC.loom:listSessions`, preload `window.loom.getSession`, `use-sessions.ts`, `session-chat.tsx`, `session-bar.tsx`, `ChatSessionContext`, and 50 distinct `.session-*` selectors.

Size: `session` occurs 21× in `packages/agent/src`, 622× in `packages/app/src`, 217× in `packages/app/tests`, 192× in `packages/app/e2e`.

**Keep — false friends, not this concept:**

- `McpSession`, `McpSessionFactory`, `openSdkSession`, `toolsFromMcpSession` — MCP transport session.
- `sessionId` in `streamSimple` options and durable `ProviderDoc.sessionId` — provider-side conversation identity, vendor-owned.
- `sessionPositions` in `workbench/graph-simulation.ts` — process-local layout memory.
- `.loom/harness-sessions/` — historical data; keep the directory name.

**Decided:** rename everything in one program, including user-facing copy and CSS selectors. Two consequences to implement with it.

- **Title constant.** `DEFAULT_CONVERSATION_TITLE = "New conversation"` seeds `LoomConversationDoc.initial()`, so new conversations get the new text; documents already stored keep `"New session"`. Both must count as "untitled" where Loom auto-titles (`ChatService.prepareTurn()`) and where `ChatService` falls back (`ChatService.getSession()`), so expose one `isDefaultConversationTitle(title)` helper and keep `"New session"` inside it only.
- **Locale.** `t.sessions.*` becomes `t.conversations.*`: "New session" → "New conversation", "Starting a session…" → "Starting a conversation…", "Delete this session?" → "Delete this conversation?"; Chinese 会话 → 对话 wherever it means the chat. E2e specs match these strings by role/name, so they move in the same change. `DEFAULT_SESSION_TITLE` must not ship without the helper.

**Phases** — each ends with `pnpm typecheck && pnpm test` green, no behavior change, `vendor-pi-*` untouched:

1. `@loom/agent`: `session-dto.ts` → `conversation-dto.ts`, `session-title.ts` → `conversation-title.ts`, `LoomSession{Record,Summary,Model}` → `LoomConversation*`, `DEFAULT_CONVERSATION_TITLE` + `isDefaultConversationTitle()`, `liveMessagesForSession`/`agentSessionId` in `shared/ag-ui-messages.ts`. Reached by consumers only through the `durable.ts`/`index.ts` re-exports.
2. IPC contract in one commit: channel strings (`loom:listSessions` → `loom:listConversations` …), `IPC` method names, preload surface, `ChatService` methods (`listSessions` → `listConversations`, `setSessionName` → `setConversationTitle`, `archiveSession`/`unarchiveSession`/`deleteSession`/`setSessionModel`), `ipcMain.handle` registrations, `shared/ipc.ts` types, and the literal `"New session"` fallback in `chat-service.ts`.
3. Renderer: `use-sessions.ts` → `use-conversations.ts`, `session-chat.tsx`, `session-bar.tsx`, `ChatSessionContext`/`useChatSession` in `chat-context.ts`, `t.sessions` → `t.conversations` with both locales' copy, and all 50 `.session-*` selectors in `session.css`/`styles.css`/`dock.css`.
4. Tests, e2e specs, docs: `packages/app/tests`, `packages/app/e2e` (role/name lookups such as `agent.spec.ts`), `docs/agent/AGENT*.md` §1/§3/§6, `docs/PRODUCT*.md` (`sessions/` tree), `docs/TODO*.md`.

**Acceptance:** `grep -rn session packages/{agent,app}/src` leaves only the keep list, no `.session-` selector remains, and typecheck, unit tests and e2e are green.

---

## Rules

- One entry per stale or entangled surface, with the symbols named.
- Record the decision, not the discussion.
- Delete an entry when the code is gone; log finished work in the [archive](./archive/ARCHIVE.md).
