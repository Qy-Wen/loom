[简体中文](./CLEANUP.zh-CN.md) | **English**

# Cleanup backlog

> Places that are dead, duplicated, named after a design that no longer holds, or entangled so that no part can be read alone. This is not a feature roadmap (see [TODO](./TODO.md)); every entry here should end in deletion, reconnection, a renamed concept, or a decomposition.
> An entry needs: what is out of shape, why, the concrete symbols involved, and the decision that unblocks cleanup.

---

## 1. `LoomAgUiAgent.observe()` is one 290-line closure

**Status:** structural; split boundaries need confirmation before any code moves.

`ag-ui-agent.ts:47-334` holds the whole AG-UI ↔ durable adapter inside one `new Observable(...)` initializer: composer input consumption and folding, run lifecycle and cancellation, durable → AG-UI event translation, partial text/reasoning assembly, tool and child-conversation watches, approval activity, inbox boundary bookkeeping for follow-ups, submission wait, and teardown. Every stage shares the same mutable closure state (`messageId`, `sentText`, `sentThinking`, `partialBlocks`, `knownTools`, `boundaries`, `boundaryWait`, `cancelled`, `finished`), so no stage can be read or tested without the rest. `run()` and `connectThread()` differ only by the `submit` flag, which gates input consumption, the `conversation.submit()` call, and the teardown abort.

**Split targets:**

- `createMessageSink(emit)` — `messageId`/`sentText`/`sentThinking`, `partialBlocks`, and `close`/`textDelta`/`thinkingDelta`/`renderPartial`/`startTool`.
- `translateDurableEvent(...)` — the `onEvent` switch: durable `AgentEvent`/`SnapshotEvent` → AG-UI plus the `loom.*` custom events. Protocol mapping only, no lifecycle.
- `watchChildConversation(...)` — `watchChild`, `restoreChild`, `watchedChildren`, and the stop handles it returns.
- `submitTurn(...)` — `takeComposerImages`/`takeComposerAssets`, `foldUserText`, title, empty-input check, `conversation.submit`, `submission.wait`, `existingRequest`/`answerSeen` handling.
- `drainFollowUps(...)` — `placedInput`, `boundaries`, `boundaryWait` passed in explicitly instead of captured as mutables.
- `finishRun(...)` — `loom.history_changed`, `RUN_FINISHED`, and the `finally` teardown (`approvals.stop`, `stream.stop`, child stops, `complete`).

**Decision needed:** confirm these boundaries before splitting, and decide whether `translateDurableEvent` moves to its own module. It is the only part that can be unit-tested against a synthetic event sequence.

---

## 2. Align Loom's vocabulary with durable: `session` → `conversation`

**Status:** plan, not started; scope decided (identifiers, copy and CSS all move).

Durable already says conversation: `ConversationId`, `harness.conversation()`, `ConversationDoc`, the `loom.conversation` doc kind, `conversation-metadata.ts`. Above that line Loom still says `session`, so one object has two names and the stale one is the one app developers read first: `LoomSessionRecord`/`LoomSessionSummary`/`LoomSessionModel` (`session-dto.ts`), `session-title.ts`, `LibraryAgentHost.listSessions`, `IPC.loom:listSessions`, preload `window.loom.getSession`, `use-sessions.ts`, `session-chat.tsx`, `session-bar.tsx`, `ChatSessionContext`, and 50 distinct `.session-*` selectors.

Size: `session` occurs 21× in `packages/agent/src`, 622× in `packages/app/src`, 217× in `packages/app/tests`, 192× in `packages/app/e2e`.

**Keep — false friends, not this concept:**

- `McpSession`, `McpSessionFactory`, `openSdkSession`, `toolsFromMcpSession` — MCP transport session.
- `sessionId` in `streamSimple` options and durable `ProviderDoc.sessionId` — provider-side conversation identity, vendor-owned.
- `sessionPositions` in `workbench/graph-simulation.ts` — process-local layout memory.
- `.loom/harness-sessions/` — historical directory name only; see §3.

**Decided:** rename everything in one program, including user-facing copy and CSS selectors. Two consequences to implement with it.

- **Title constant.** `DEFAULT_CONVERSATION_TITLE = "New conversation"` seeds `LoomConversationDoc.initial()`, so new conversations get the new text; documents already stored keep `"New session"`. Both must count as "untitled" where Loom auto-titles (`ag-ui-agent.ts:74`) and where `LibraryAgentHost` falls back (`library-agent-host.ts:149`), so expose one `isDefaultConversationTitle(title)` helper and keep `"New session"` inside it only.
- **Locale.** `t.sessions.*` becomes `t.conversations.*`: "New session" → "New conversation", "Starting a session…" → "Starting a conversation…", "Delete this session?" → "Delete this conversation?"; Chinese 会话 → 对话 wherever it means the chat. E2e specs match these strings by role/name, so they move in the same change. `DEFAULT_SESSION_TITLE` must not ship without the helper.

**Phases** — each ends with `pnpm typecheck && pnpm test` green, no behavior change, `vendor-pi-*` untouched:

1. `@loom/agent`: `session-dto.ts` → `conversation-dto.ts`, `session-title.ts` → `conversation-title.ts`, `LoomSession{Record,Summary,Model}` → `LoomConversation*`, `DEFAULT_CONVERSATION_TITLE` + `isDefaultConversationTitle()`, `liveMessagesForSession`/`agentSessionId` in `shared/ag-ui-messages.ts`. Reached by consumers only through the `durable.ts`/`index.ts` re-exports.
2. IPC contract in one commit: channel strings (`loom:listSessions` → `loom:listConversations` …), `IPC` method names, preload surface, `LibraryAgentHost` methods (`listSessions` → `listConversations`, `setSessionName` → `setConversationTitle`, `archiveSession`/`unarchiveSession`/`deleteSession`/`setSessionModel`), `ipcMain.handle` registrations, `shared/ipc.ts` types, and the literal `"New session"` fallback in `library-agent-host.ts`.
3. Renderer: `use-sessions.ts` → `use-conversations.ts`, `session-chat.tsx`, `session-bar.tsx`, `ChatSessionContext`/`useChatSession` in `chat-context.ts`, `t.sessions` → `t.conversations` with both locales' copy, and all 50 `.session-*` selectors in `session.css`/`styles.css`/`dock.css`.
4. Tests, e2e specs, docs: `packages/app/tests`, `packages/app/e2e` (role/name lookups such as `agent.spec.ts`), `docs/agent/AGENT*.md` §1/§3/§6, `docs/PRODUCT*.md` (`sessions/` tree), `docs/TODO*.md`.

**Acceptance:** `grep -rn session packages/{agent,app}/src` leaves only the keep list, no `.session-` selector remains, and typecheck, unit tests and e2e are green.

---

## 3. `.loom/harness-sessions/` has no runtime referent

**Status:** decided, edit not applied; no behavior change.

The pre-durable session manager is gone and nothing replaces its reader. `packages/*/src` never mentions the directory, and the ignore contract does not depend on the name: `isIgnoredPath()` covers every `.loom/` path through the prefix test in `library-paths.ts:39-56`. Four mentions remain; only two carry information.

- `packages/agent/vendor-tests/library-agent.test.ts:33-53` — writes invalid JSONL into the directory, then asserts the conversation list stays empty and the file is byte-identical after open and close. **Keep.** It is the only guard that opening a library neither reads nor deletes unknown `.loom/` data.
- `packages/core/tests/library-paths.test.ts:24-25` — asserts `.loom/sessions/` and `.loom/harness-sessions/` are ignored. **Redundant:** line 23 already exercises the same rule with `.loom/metadata.db`.
- `docs/agent/AGENT.md:65` / `.zh-CN` — the only place that says what the directory is. Keep the fact, but state the rule rather than a one-off: legacy directories under `.loom/` are ignored, never read or deleted.

**Edit:** delete `library-paths.test.ts:24-25`, reword the AGENT line as that general rule, leave `docs/archive/` untouched.

---

## Rules

- One entry per stale or entangled surface, with the symbols named.
- Record the decision, not the discussion.
- Delete an entry when the code is gone; log finished work in the [archive](./archive/ARCHIVE.md).
