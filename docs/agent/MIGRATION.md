**English** | [简体中文](./MIGRATION.zh-CN.md)

# Agent Core Migration — pi `packages/agent` harness → `pi-durable`

> Migration design and acceptance record for Pi harness → `@earendil-works/pi-durable`. Current architecture: [AGENT](./AGENT.md).
> Core implementation is complete; final status and remaining acceptance are in §10. Old-API tables below are migration mappings, not the current implementation. Existing sessions are incompatible and are not migrated.
>
> **Source baseline:** follow upstream `main`, not the `v1.1.0` tag. The image processor, nested tools, structured output, and code mode described below were added after that tag. `UPSTREAM` records the actual synced commit; npm dependencies must be checked against it.

---

## 1. Background

At v0.85.1, the vendored `packages/agent` bundled two layers:

- **Agent loop:** `agent.ts`, `agent-loop.ts`, `types.ts`, `proxy.ts`, `stream-fn.ts`
- **Harness:** `harness/**` — `AgentHarness`, `AgentLane`, `Session` / `JsonlSessionRepo` / `MemorySessionRepo`, built-in tools, `loadSkills`, compaction, telemetry

Pi 1.1.0 splits them and does **not** keep the harness in `packages/agent`:

| | v0.85.1 | 1.1.0 |
|---|---|---|
| `packages/agent` | loop + harness | `@earendil-works/pi-agent-core`: low-level loop only |
| harness | inside `packages/agent` | `@earendil-works/pi-durable` 1.1.0, a rewrite on `chord` (storage / task / document / transaction); **does not depend on pi-agent-core** |
| telemetry producer | harness called `startAiSpan` / `startHarnessSpan` | none |

Consequence: the vendored `harness/**` has no upstream successor branch. It is frozen at v0.85.1 and would have to be maintained entirely by Loom.

---

## 2. Is migration required?

**Not for features.** The old harness already has session, automatic compaction (threshold + overflow), retry, crash recovery, fork, usage, and image processing. Durable is a re-architecture with roughly the same feature set, plus:

- child tasks / owned subagents (the old harness has none)
- SQLite / JSONL / Memory / Durable Object storage with a conformance suite (old: JSONL + memory)
- a hot-swappable registry of extensions / sections / hooks / wraps
- structured tool output, nested tool calls (`executeTool`), code mode

Durable lacks a telemetry producer, the Agent Skills loader, and prompt templates.

The driver is therefore **long-term maintainability** — stop forking `harness/**`, stay on upstream — not new capability. If that is not a priority, staying on v0.85.1 is viable.

Durable's compaction policy (`DEFAULT_COMPACTION_POLICY`) differs from the old harness's. Runtime, tool, and Electron acceptance have been exercised; complete old/new equivalence still requires controlled comparisons. See §10 and [EVALS](./EVALS.md).

---

## 3. Scope: shaped by durable, not confined to `@loom/agent`

The migration should follow durable's primitives — conversation, entry, document, task, submission, registry, watch/view — instead of wrapping them to imitate the old `HarnessSessionManager` / lane API. `packages/app` is therefore in scope.

What that means concretely:

- **Owner, not lanes.** Replace `HarnessSessionManager` with a durable-shaped owner: one `Harness` per open library plus a `Registry`, exposing `Conversation` handles. There is no `lane`, `accept`, `drive`, or hand-written recovery.
- **Documents for app state.** Session title, archive flag, and other Loom per-conversation state become `defineDoc`s read and written in commits, not sidecar session values.
- **Inbox for busy handling.** Steer / follow-up / reject use `submit(..., { whenBusy })` and `pi.inbox`, not a hand-rolled follow-up map.
- **Owned subagents for specialists.** `run_retrieve_agent` / `run_create_agent` become owned conversations (`ownership: { kind: "task", taskId }`), not a per-call in-memory harness. Neither is `background` (§9 decision 6), so Stop interrupts them and the conversation is busy while they run.
- **Registry for tools and prompt.** Loom tools, the system prompt, skills/memory injection, and the permission gate become an extension (tools, sections, hooks, wraps) installed in the registry.
- **Committed state for the UI.** The app reads `conversation.viewState()` / `watch()` and/or `watchEvents()`. `LoomAgUiAgent` stays as the AG-UI protocol boundary, but its input changes from `LoomAgentEvent` + manager methods to durable views/events.
- **One SQLite store per library** (e.g. `<library>/.loom/loom.sqlite`), replacing the `harness-sessions/` JSONL directory.

Boundary preference: AG-UI remains the frontend protocol, and `packages/app` should prefer a thin `@loom/agent` facade over importing `pi-durable` types directly. Resolved in §9 decision 1 (keep the thin facade).

Files outside `packages/agent` this touches: session listing (→ `scanConversations` + Loom documents), the renderer session/context panel, dev-trace (§8), and every `packages/app` caller that relied on old session-manager behavior. The size is not small: `harness-session-manager.ts` is 1105 lines referenced from 14 files, and three of them are app main-process files — `ag-ui-agent.ts` (512 lines), `agent-server.ts`, `index.ts` — all of which get rewritten. §5 has a dedicated app-side mapping table.

**No backward compatibility.** The old `<library>/.loom/harness-sessions/` JSONL, the stored transcript shape, the `attachments` sidecar, and the `loom_user_stop` entry projector are all dropped. A library keeps one durable store; old session files are ignored, not migrated. Design the clean path, not a reader for what exists.

---

## 4. Dependency changes

| Dependency | Now | After | Note |
|---|---|---|---|
| `@earendil-works/pi-ai` | 0.85.1 | 1.1.0 | `createModels` / `createProvider` move under `/models`; verify API-factory paths |
| `@earendil-works/chord` | 0.85.1 | 1.1.0 | `BACKGROUND_CONTEXT`, `Context` from `@earendil-works/chord/context` |
| `@earendil-works/pi-durable` | — | vendored source | The new harness, vendored as `vendor-pi-durable/src`; subpaths mapped via `#vendor/pi-durable/*`; see Vendoring below |
| `@earendil-works/pi-codemode` | — | vendored source (`workspace:*`) | `vendor-pi-codemode/src`, synced with durable from the same upstream `main` commit; only its `quickjs-wasi` dependency stays npm |
| SQLite driver | `better-sqlite3` (core store) | Durable: `node:sqlite`; core: `better-sqlite3` unchanged | Durable's `/storage/sqlite/node` uses Node's built-in `node:sqlite` (`DatabaseSync`). Two drivers coexist over separate files (`.loom/loom.sqlite` for durable, the retrieval store for core); unifying them is out of scope. See §9 |
| `@earendil-works/pi-telemetry` | 0.85.1 | 1.1.0 | Contracts only; no runtime producer anywhere in pi 1.1.0 |
| `@silvia-odwyer/photon-node` | 0.3.4 | remove | Durable's image processor uses `@silvia-odwyer/photon` instead |
| `@silvia-odwyer/photon` | — | 0.3.3 | Durable dependency for `createNodePhotonImages()` |
| `diff`, `typebox` | pinned | keep | `diff` if Loom edits diffs; `typebox` for Loom tool schemas |
| `ignore`, `yaml` | pinned | only if skills are self-hosted | They served the old `loadSkills` |

### Vendoring durable

Durable is vendored as source, the same way `packages/agent` is today. Replace `vendor-pi-agent/` with `vendor-pi-durable/`:

```
packages/agent/
├── package.json        # imports: "#vendor/pi-durable", "#vendor/pi-durable/tools", ...
├── tsconfig.json       # matching paths
├── src/                # Loom code; the only place that imports #vendor/pi-durable
├── vendor-pi-durable/
│   ├── UPSTREAM        # repo: .../pi.git, directory: packages/durable, ref, commit
│   ├── sync.sh         # delegates to sync.mjs; syncs both vendors
│   └── src/            # pristine upstream source
└── vendor-pi-codemode/
    ├── package.json    # private workspace; preserves upstream package name/exports
    ├── UPSTREAM        # directory: packages/codemode; same ref and commit
    └── src/            # pristine upstream source
```

`sync.sh` mirrors `packages/durable/src/` (`rsync --delete`, excluding `**/*.test.ts`, `**/testing/**`, `benchmark/**`), records the ref and commit in `UPSTREAM`, and defaults to `main`. `sync.sh` delegates to `sync.mjs`, which mirrors both `packages/durable/src` and `packages/codemode/src` from one clone, records their directories and identical commits, and provides an equivalent filesystem mirror on native Windows. Loom-owned codemode package/build configuration stays outside `src/` and survives sync; durable's imports of `@earendil-works/pi-codemode` resolve to this private workspace without rewriting vendor source. Note that excluding `**/testing/**` makes durable's `./testing` export (the storage conformance suite) unavailable from the vendored copy; to reuse that suite, either copy it separately or depend on the npm `@earendil-works/pi-durable`.

Entry points: map the durable subpaths Loom uses through `imports` / tsconfig:

- `#vendor/pi-durable` → `vendor-pi-durable/src/index.ts`
- `#vendor/pi-durable/tools` → `vendor-pi-durable/src/tools/index.ts`
- `#vendor/pi-durable/codemode` → `vendor-pi-durable/src/codemode/index.ts`
- `#vendor/pi-durable/env/node` → `vendor-pi-durable/src/env/node.ts`
- `#vendor/pi-durable/images/node` → `vendor-pi-durable/src/images/node.ts`
- `#vendor/pi-durable/storage/sqlite/node` → `vendor-pi-durable/src/storage/sqlite/node.ts`
- `#vendor/pi-durable/storage/jsonl/node` → `vendor-pi-durable/src/storage/jsonl/node.ts`

Application code still imports only `@loom/agent`; keep the single boundary (`pi-adapter.ts` or a new `durable-adapter.ts`).

External deps stay npm and align with durable's version: `@earendil-works/chord` 1.1.0, `@earendil-works/pi-ai` 1.1.0, `typebox`, `diff`, and add `@silvia-odwyer/photon` (durable's image processor uses it, not `photon-node`). pi-agent-core is no longer needed.

The vendor-branch rules are unchanged: `vendor-clean` holds pristine source, `main` carries local changes, sync only on `vendor-clean`, and Loom-owned additions go in `src/`, not `vendor-pi-durable/src/` (where the next sync deletes them).

Because durable is Experimental and changes quickly, expect more merge churn than the old harness. Telemetry does not touch the vendor: later it goes in as an extension (§8), keeping the vendored copy pristine upstream.

---

## 5. File-by-file mapping

| File | Old dependency | New approach |
|---|---|---|
| `pi-adapter.ts` | `convertToLlm`, `AgentMessage` | `buildChatModels` now uses pi-ai 1.1.0 `/models`; the lazy OpenAI-completions API path is unchanged. `convertToLlm` / `toProviderMessages` are removed: durable entries carry `model: Message[]` directly, so attachment folding moves to submit time |
| `pi-tools.ts` | `AgentHarnessTool`, `createReadTool({imageProcessor})`, `createBashTool({prepare})`, `ExecutionToolContext` | Use durable `createCodingTools()` / `createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool`; rewrite `toHarnessTool` as `defineTool` (`execute(args, api, context)` → `{ output, details }`). Bash `prepare` becomes `BashExecution {command, cwd, env, inheritEnv}` + `api` + `context`; adapt `prepareSandboxedBash`. `ExecutionToolContext` / `setCwd` disappear: env is built per call by `HarnessOptions.env` from the conversation `cwd` |
| `read-image.ts` | `ReadImageProcessor` / `ReadImageProcessorResult` | Replace with durable `ImageProcessor.prepare(bytes, mimeType, limits) → PreparedImage`; use `createNodePhotonImages()` and delete the file |
| `library-skills.ts` | `loadSkills`, `formatSkillsForSystemPrompt` | No equivalent export; self-host over the durable `ExecutionEnv`, or port coding-agent `core/skills.ts`. Inject the catalog as a prompt `section` |
| `library-auto-memory.ts` | `AgentHarnessTool`, `ExecutionToolContext` | Type-only swap to `defineTool` + `ToolExecutionApi`. Inject the note as a `section` / `instructions` |
| `agent-instructions.ts` | — | Map to per-conversation `instructions` (rendered as the `instructions` section) |
| `session-title.ts` | — | Pure text helper (`titleFromUserText`), no harness dependency; only the title *storage* moves to a Loom `defineDoc` — see §9 decision 5 |
| `attachments.ts` / `composer-asset.ts` | folded in via `convertToLlm` | The sidecar field itself is no longer needed; the fold into `content` moves from `convertToLlm` to just before `submit` |
| `tool-permission.ts` | `hooks.on("before_tool")` | The `AGENT_PERMISSION_LEVELS` / `ToolGateDecision` logic carries over unchanged; the attachment point becomes `hook(ToolTask, { beforeTool })`. Publishing the waiting state is in §6 |
| `specialist.ts` | `AgentHarness` + `MemorySessionRepo` | Drop the per-specialist in-memory harness; use durable owned subagents (§9 decision 6: both retrieve and create are owned, neither `background`). **`Tx` and `Conversation` are two API levels — do not mix them:** inside a tool, go through `Tx` — `api.commit(tx => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }))`, then take a handle with `api.conversation(childId)`. Only the Harness level has `harness.createConversation({ ownership }, context)` and `Conversation.fork(at, { ownership }, context)` |
| `harness-session-manager.ts` | `JsonlSessionRepo`, `AgentHarness.create`, `lane.accept/drive/followUp/abort/resume`, `hooks.on`, `events.on`, `estimateContextTokens`, `laneConfig/laneState/value` | Full rewrite — see §6 |
| `run-trace.ts` / `trace-io.ts` | `withTelemetryContext`, pi-telemetry spans | Not in this migration: remove the dependency on `withTelemetryContext` / pi-telemetry, leave the `LoomTraceSpan` type and dev-trace UI untouched; rebuild later on a durable extension — see §8 |
| tests / evals | `AgentHarness`, `JsonlSessionRepo`, `NodeExecutionEnv`, `estimateTokens`, `findCutPoint`, `span-io` | Rewrite; `BACKGROUND_CONTEXT` moves to `@earendil-works/chord/context` |

### App side (`packages/app`)

Replacing the session manager does not stop at `packages/agent`. App-side files referencing `HarnessSessionManager` today:

| File | Old dependency | New approach |
|---|---|---|
| `src/main/ag-ui-agent.ts` | `HarnessSessionManager` methods + `LoomAgentEvent` | Consume the `watchEvents(harness, conversationId)` `AgentEvent` stream plus the Loom channel (§9 decision 2); rewrite the AG-UI mapping; hold durable `Conversation` handles |
| `src/main/agent-server.ts` | manager routing | Same; the outward RPC shape is unchanged, the internals become durable handles |
| `src/main/index.ts` | manager lifecycle | Hold and close a per-library `Harness` + `Registry` |
| `tests/ag-ui-agent.test.ts` | manager stub | Rebuild the stub over memory storage + `createRegistry()` |
| `evals/*`, `scripts/try-agent.ts`, `tests/*` | `AgentHarness`, `JsonlSessionRepo` | See the last row above |

---

## 6. Session manager: replace, not port

The old `HarnessSessionManager` owned lanes, sessions, recovery, and event translation. Durable splits those responsibilities across the `Harness`, `Conversation`, tasks, and views; a durable-shaped owner should delegate to them rather than reimplement. The old-API-to-durable checklist:

| Now | Durable |
|---|---|
| `JsonlSessionRepo({ fileSystem, sessionsRoot })` | `openNodeSqliteStorage(file)` (recommended; JSONL keeps the full history in memory) or `openNodeJsonlStorage(dir)` — the Node SQLite adapter uses `node:sqlite`, see §9 |
| `AgentHarness.create({ session, models, model, tools, toolContext, systemPrompt, toProviderMessages, compaction, ... })` | `Harness.open(storage, { models, registry, settings, env }, context)` — `context` is a required third argument and is easy to miss |
| `harness.lane("main")` + `lane.accept({kind:"prompt"})` + `lane.drive()` | `harness.root()` / `harness.conversation(id)` → `conversation.submit({type:"input", content, requestId})` → `submission.wait()` |
| `lane.abort`, `lane.resume`, hand-written recovery | `conversation.abort()`, `harness.resume()`, idempotent `submit` with `requestId` |
| `lane.followUp` / steering | `submit(..., { whenBusy: "steer" \| "followUp" \| "reject" })` |
| `lane.navigateTree` / `repo.fork({ scope:"branch", position:"before" })` | `Conversation.fork(at: EntryId, options: ConversationCreateOptions, context)` where `options = { ownership, agent?, init? }`; use fork-and-switch: fork from the context before the target user message, switch to the new conversation, and archive/hide the old one. Keep the old conversation records because the fork inherits history through its parent relationship. `conversation.context(ctx, { at })` previews the fork-point context without creating a branch |
| `session.setName` / `setValue(ARCHIVED)` | No title/archive concept; store separately in a per-conversation `defineDoc`, not as entries (§9 decision 5) |
| `session.getValue(laneConfig/laneState)` | `conversation.configure()` / `conversation.agent()` / `harness.inspect()` |
| Session list | `Storage.scanConversations({ ownerConversationId?, order? })`; no `cwd` filter, so "one group per library" needs its own ownership mapping |
| `hooks.on("before_tool", …)` | `defineExtension({ hooks: [hook(ToolTask, { beforeTool: call => … })] })`; `call.id/name/arguments` available; async user approval still works |
| `events.on("message_update" / "thinking_*" / "tool_*" / "usage" / "compaction_*" / "retry_*")` | `watchEvents(harness, conversationId)` `AgentEvent` (`message_update` deltas, `tool_execution_*`, `auto_retry_*`, `compaction_*`, `usage_changed`), or `conversation.watch()` / `viewState()`; rewrite the `LoomAgentEvent` translation |
| `estimateContextTokens` / `calculateContextTokens` | Loom `contextUsage()` uses active `ContextView` and pi-ai estimates: latest applicable usage + trailing messages. `harness.usage()` is cumulative spend, not current occupancy |
| `entryProjectors: { loom_user_stop }` | A custom entry kind + `entry.model`, or a generation hook |

**Permission waiting** has no durable event. The `beforeTool` hook may await, so the gate works; the waiting state is published by Loom — a Loom `defineDoc` (pending approvals) observed with `watchDoc`, plus a Loom-owned event — because durable's `watchEvents` stream cannot be injected into.

Three `HarnessOptions` details worth remembering on their own:

- **`env` is a factory, not an instance.** Its signature is `(target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<...>` with `EnvTarget = { conversationId, cwd?, read }`. Construct `new NodeExecutionEnv({ cwd: target.cwd })` on demand; this is what replaces the old `setCwd` pattern.
- **`conversationCreated` is where the ownership mapping goes.** `HarnessOptions.conversationCreated?: (tx, conversation) => void | Promise<void>` runs inside every commit that creates or forks a conversation (before `init`). That is the place to initialize per-conversation Loom `defineDoc`s and to build the "one group per library" ownership mapping that the Session-list row below lacks.
- **`registry` is required and bound to the Harness instance.** The registry from `createRegistry()` must contain the built-in tasks (`Harness.open` throws otherwise), and a `Harness` fixes its registry instance when opened; hot-swap granularity is `Registry.install()` / `uninstall()` inside that registry — swapping registries means reopening the Harness.

---

## 7. Capability parity and gaps

| Capability | Old harness | Durable |
|---|---|---|
| Session / branch / values | yes | yes (conversations / documents) |
| Automatic compaction (threshold + overflow) | yes | yes (`settings.compaction`, plus manual `compact()`) |
| Retry | yes (`RetryPolicy`) | yes (`auto_retry_*`) |
| Crash recovery | yes (`recovery.ts`, `lane.resume`) | yes (`harness.resume()`, durable tasks) |
| Fork | yes (`repo.fork`) | yes (`conversation.fork`) |
| Usage | yes | yes (`pi.usage`, `harness.usage()`) |
| Image processing | yes (`tools/image.ts`) | yes (`createNodePhotonImages`) |
| Child tasks / owned subagents | **no** | yes |
| Storage backends | JSONL + memory | SQLite / JSONL / memory / Durable Object |
| Hot-swappable registry | no | yes (extensions/sections/hooks/wraps), but only within a registry: `Registry.install()` / `uninstall()` hot-add and hot-remove extensions; a `Harness` binds the registry passed at open, so swapping registries means reopening the Harness |
| Structured output / nested tools / code mode | no | yes |
| Telemetry spans | yes | **no producer** |
| Agent Skills loader | yes | **no** |
| Prompt templates | yes | sections only |

---

## 8. Telemetry

`pi-telemetry` 1.1.0 is intact as contracts, but **no runtime in pi 1.1.0 emits spans**: only `pi-ai` imports it (for the pass-through `ProviderRequestOptions.telemetryContext` type), and nothing calls `startSpan`. The old harness was the only producer, and durable has none.

What the old harness actually emitted (not what the schema declared):

| Span | Emitted attributes |
|---|---|
| `pi.ai.request` | start: operation / provider / model / api / streaming; end: `stop_reason`, `usage.*` |
| `pi.harness.step` | lane / operation / `step.kind` / `step.attempt` / `compaction.reason` → `step.outcome` |
| `pi.harness.turn` | lane / operation / `turn.id` |
| `pi.harness.tool` | lane / operation / turn / `tool.name` / `tool.call_id` / `tool.replay` / `tool.recovery` → `tool.is_error` |
| `pi.harness.run` | session / lane / operation / `operation.recovery` → `operation.outcome` |
| `pi.harness.compaction`, `pi.harness.navigation` | as run |
| `pi.harness.hook` | `hook.name` → `hook.outcome` |

Declared in the schema but **never emitted**: `pi.harness.checkpoint`, `pi.harness.sleep`, `pi.harness.event_handler`, `pi.session.write`, and the `pi.ai.request` end attributes `http.status_code`, `stream.chunk_count`, `stream.time_to_first_chunk_ms`, `response.id`, `response.model`, `error.type`. They were always absent, so they are not a migration loss.

Loom adds `loom.io.input` / `loom.io.output` (model request, assistant reply, tool args/result). These must be re-owned.

Durable seams:

| Old span | Durable seam | Fidelity |
|---|---|---|
| `pi.ai.request` | `hook(GenerationTask, { beforeRequest, afterResponse })`; provider/model/api from `pi.agent` + `HookApi.models.getModel()` | good |
| stop reason / usage / `durationMs` / `responseId` / `responseModel` / `diagnostics` | `AssistantMessage` | full (more than before) |
| `loom.io.input` / `loom.io.output` | `beforeRequest.messages` / `afterResponse` message (render the structured system sections) | good |
| `pi.harness.run` / `turn` / `step` | `watchEvents` `run_*` / `turn_*` + `beforeRequest` attempt + `auto_retry_*` | good (timing from event arrival) |
| `pi.harness.tool` | `ToolTask` `beforeTool` / `afterTool`, or `wrapTool` | call id / name / is_error yes; `replay` needs a Loom name → policy map; `recovery` unavailable |
| `pi.harness.compaction` | `compaction_start` / `compaction_end` | full |
| `pi.harness.hook` | only Loom's own handlers | partial |
| `pi.harness.navigation` | none | not needed |

Irreducible gaps:

1. **Deferred requests.** `classify()` returns before `afterResponse` when `stopReason === "deferred"`, so a `beforeRequest → afterResponse` pair does not bracket a deferred request; use `deferred_poll` or merge the span.
2. **Tool recovery.** Recovery runs the `execute` phase without `beforeTool` / `afterTool`, so `pi.tool.recovery` is not observable; `wrapTool` wraps execution but cannot easily tell it is a recovery.
3. **System prompt text** in `loom.io.input` must be rendered from durable's structured `sections`.
4. HTTP status / chunk count / TTFT are not produced by either pi-ai version.

**Scope: telemetry is not part of this migration; it comes later, built on durable's extension mechanism rather than a fork of durable.** Until then dev-trace emits no spans (the UI and the `LoomTraceSpan` type stay).

The later approach: a telemetry extension (`hook(GenerationTask, …)` + `hook(ToolTask, …)`) plus one `watchEvents` observer per conversation, and a Loom-owned manual-start/end `TelemetryContext` maintaining a span tree keyed by `conversationId` / `taskId` / `callId`. `LoomTraceSpan` and the dev-trace UI stay unchanged if span names/attributes match.

This requires re-owning `AI_TELEMETRY_SCHEMA` / `HARNESS_TELEMETRY_SCHEMA` (they live in the old vendor and disappear with it; `pi-telemetry` still provides `defineTelemetrySchema` / `createTypedSpanStarter`), and dropping `withTelemetryContext` — durable does not read telemetry off the chord `Context`.

---

## 9. Decisions

Resolved:

1. **Facade or direct durable types → thin `@loom/agent`.** Forward durable's generic types and handles (`Harness`, `Conversation`, `EntryRecord`, `ConversationView`, `watchEvents`, `defineTool` / `defineExtension` / `section` / `hook` / `defineDoc`); wrap only Loom-specific assembly and policy — tools, prompt sections, skills/memory, the permission gate, Loom documents, and the per-library `Harness` lifecycle. `packages/app` main holds durable handles; IPC and renderer stay on Loom DTOs, so upstream churn does not cross the process boundary. Rule of thumb: forward generic runtime and live handles, wrap Loom-specific and cross-process.
2. **UI input → durable `watchEvents`.** AG-UI is driven by durable `AgentEvent` (one batch per commit, preceded by a `snapshot` on attach), not by `viewState()` / `watch()` as the primary channel. Rationale: the stream is incremental, so crossing the process boundary with deltas avoids serializing full snapshots, and the `LoomAgentEvent` translation already operates at event granularity. The cost is rebuilding the full view on attach/reconnect. If that gets convoluted, the fallback is `viewState()` (an `AttachedReplicatedState<ConversationView>` snapshot) for the attach state with `watchEvents` for deltas — the two do not conflict and can be switched at any time. Loom-owned state durable does not emit — pending approvals, dev-trace, follow-up display — rides a Loom channel: a Loom `defineDoc` observed with `watchDoc`, plus Loom-owned events. `LoomAgentEvent` is retired as the transport; its AG-UI mapping moves to the durable stream plus the Loom channel.
3. **Storage backend → SQLite.** One store per library (e.g. `<library>/.loom/loom.sqlite`), replacing the `harness-sessions/` JSONL directory; no old format to honor.
4. **SQLite driver → durable's built-in `node:sqlite`** (`openNodeSqliteStorage`, `DatabaseSync`). No facade, no `better-sqlite3` for durable. `packages/core` keeps `better-sqlite3` for the retrieval store; unifying the two drivers is out of scope.

   **Prerequisite verified on macOS:** `pnpm --filter @loom/app check:node-sqlite` launches a real Electron 38.2.2 main process (Node 22.19.0); `node:sqlite` read/write/reopen passes. A second Electron process can write under WAL while the first holds a read snapshot; simultaneous writers are excluded by SQLite locks. This does **not** make multiple durable owners safe: durable has no cross-process session locking and each library store must have one active Harness owner. Windows still needs the same probe run on-device.

5. **Session metadata → per-conversation `defineDoc`, stored separately, not as entries.** Title, archive, and other Loom per-conversation state are metadata, not transcript: no entry is written, they take no part in model context or compaction, and they are not replayed with history. Read and write inside commits, observe with `watchDoc`, and initialize in `HarnessOptions.conversationCreated`. Use `fork: "current"` to copy the current title, then the creation hook appends `（分支）` and resets `archived: false`, leaving the source unchanged. Each nested fork adds another suffix. The session list uses `scanConversations` for the conversations, then reads each doc by id to assemble title / archive.
6. **Specialists → owned conversations, not background tasks.** Both retrieve and create use owned subagents (`ownership: { kind: "task", taskId }`), replacing a per-call in-memory harness; neither is marked `background`, preserving today's behavior: Stop interrupts a running specialist, and the conversation counts as busy while it runs.
7. **Telemetry → not in this migration; later, as a durable extension (§8).** No durable fork, no vendor changes. Dev-trace has no span output in the meantime.

Resolved:

8. **Retarget / branch-before → fork-and-switch; archive/hide the old conversation.** Fork from the context before the target user message, switch to the new conversation, and archive/hide the source; do not physically delete its records because the fork inherits history through its parent relationship.

---

## 10. Migration order

**Steps 1–8 implemented:**

- Durable/codemode are vendored from the same upstream `main` commit `4270522473e677ddba7b093caa0064a3df51d459`; Loom does not modify vendor `src/`. Isolated typechecks, 34 source tests, and one compiled worker test pass.
- macOS Electron `node:sqlite`, model endpoint/provider identity, SQLite reopen, request deduplication, and a real DeepSeek tool smoke path pass.
- `LibraryAgent` owns one Harness/Registry per library; metadata, permission, and memory use documents; skills use `ExecutionEnv`/sections; specialists use foreground owned conversations. App/root facade and tests/evals use durable, with no old-manager compatibility layer.
- AG-UI uses partial increments, explicit threadId, and durable connect/stop; detach does not cancel work. Chat paginates fork-aware entries separately from compacted model context. Regressions cover post-compaction reload, old-message forks, and completed-request reconnect.
- Electron SIGKILL acceptance covers approval, streaming, and executing unsafe bash. Approval reuses its child; streaming resends without duplicate user input and retains aborted partials; unsafe tools do not replay and report possible partial execution. External effects are not guaranteed exactly-once.
- Workspace typechecks pass; unit suites: core 133 + 1 skipped, agent 65, app 192. Electron: 10 standard tests and one opt-in live streaming test pass. A core folder-rename watcher timed out once; isolated and workspace retries passed without modifying that test.
- Strict live tool gold passed 4/4 twice, unchanged. Retrieve inspects supplied IDs first; the inspect mock matches product metadata. Compaction/cache measurements: [EVALS](./EVALS.md).

**Remaining acceptance:** Windows on-device runtime and controlled old/new compaction/cache/tool comparisons. The three accepted crash points do not cover every timing or external tool. Cross-process owner exclusivity still relies on Electron's single-instance constraint, not a new general lock.

**Context percentage restored:** current-model window and active-context estimate, without reusing pre-compaction usage; commits/model changes refresh it and `~` marks approximation. Tests cover cache/tools/images, model changes, compaction/fork/reopen, and the Electron ring.

**Step 9 deferred:** rebuild telemetry as an extension per §8.

---

## 11. Risks

- **Durable is Experimental;** API changes without notice. Track upstream `main`, record each synced commit, and expect churn.
- **Vendor churn:** vendoring the source means Loom merges frequent upstream changes and owns the fork.
- **SQLite driver:** verified in Electron 38.2.2 on macOS (§9 decision 4); Windows validation remains. SQLite WAL concurrency is not cross-process durable coordination: keep one active Harness owner per library store.
- **No compatibility (by design):** existing `.loom/harness-sessions/` sessions are ignored, not migrated.
- **Behavioral drift:** branch-before / retarget becomes fork-and-switch (creates a new conversation rather than switching in place; the old conversation is archived/hidden but retained as a history source); session title / archive and context-percent display have no 1:1 durable primitive.
- **Telemetry ownership / gap:** Loom ends up owning the producer that upstream used to ship; deferred, so dev-trace has no data in the meantime and one debugging aid is missing.

---

## 12. Summary

- Upstream moved the harness out of `packages/agent` into `pi-durable`; the vendored harness is frozen at v0.85.1.
- Durable is a re-architecture with the same core capabilities, not a feature upgrade.
- Durable and codemode are vendored from the same upstream `main` commit, replacing `vendor-pi-agent/`; npm deps are pi-ai, chord, photon, typebox, diff, and quickjs-wasi.
- Core implementation and limited runtime/tool/Electron acceptance are complete; Windows and controlled old/new comparisons remain, so complete parity is not claimed (§10).
- Backward compatibility is dropped: old session storage, transcript shape, attachment sidecar, and projector are not carried over.
- Scope follows durable's model; `packages/app` is in scope, not just `packages/agent`.
- The old session manager is deleted; the app uses durable owner/views/events and specialists are migrated. Telemetry is out of scope.
- Decided: a thin `@loom/agent` boundary, a `watchEvents`-driven UI, SQLite storage, durable on the built-in `node:sqlite`, and telemetry deferred and later built as an extension (§9). Session metadata uses a separate `defineDoc` (§9 decision 5); specialists use owned conversations without `background` (§9 decision 6); branch-before uses fork-and-switch and archives/hides the old conversation (§9 decision 8).
