**English** | [简体中文](./MIGRATION.zh-CN.md)

# Agent Core Migration — pi `packages/agent` harness → `pi-durable`

> Evaluates replacing the vendored Pi harness with `@earendil-works/pi-durable`. See [AGENT](./AGENT.md) for the current architecture.
> This document records the scope, the file-by-file mapping, capability parity, telemetry, and the open decisions. It assumes a fully backward-incompatible migration: existing session files are discarded. Update [AGENT](./AGENT.md) once the migration lands.

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

---

## 3. Scope: shaped by durable, not confined to `@loom/agent`

The migration should follow durable's primitives — conversation, entry, document, task, submission, registry, watch/view — instead of wrapping them to imitate the old `HarnessSessionManager` / lane API. `packages/app` is therefore in scope.

What that means concretely:

- **Owner, not lanes.** Replace `HarnessSessionManager` with a durable-shaped owner: one `Harness` per open library plus a `Registry`, exposing `Conversation` handles. There is no `lane`, `accept`, `drive`, or hand-written recovery.
- **Documents for app state.** Session title, archive flag, and other Loom per-conversation state become `defineDoc`s read and written in commits, not sidecar session values.
- **Inbox for busy handling.** Steer / follow-up / reject use `submit(..., { whenBusy })` and `pi.inbox`, not a hand-rolled follow-up map.
- **Owned subagents for specialists.** `run_retrieve_agent` / `run_create_agent` become owned conversations (`ownership: { kind: "task", taskId }`), not a per-call in-memory harness.
- **Registry for tools and prompt.** Loom tools, the system prompt, skills/memory injection, and the permission gate become an extension (tools, sections, hooks, wraps) installed in the registry.
- **Committed state for the UI.** The app reads `conversation.viewState()` / `watch()` and/or `watchEvents()`. `LoomAgUiAgent` stays as the AG-UI protocol boundary, but its input changes from `LoomAgentEvent` + manager methods to durable views/events.
- **One SQLite store per library** (e.g. `<library>/.loom/loom.sqlite`), replacing the `harness-sessions/` JSONL directory.

A boundary worth keeping (as a preference to confirm, not a hard rule): AG-UI remains the frontend protocol, and `packages/app` should prefer a thin `@loom/agent` facade over importing `pi-durable` types directly. Whether to keep that facade or let the app consume durable handles directly is decision 1 in §9.

Files outside `packages/agent` this touches: session listing (→ `scanConversations` + Loom documents), the renderer session/context panel, dev-trace (§8), and every `packages/app` caller that relied on old session-manager behavior.

**No backward compatibility.** The old `<library>/.loom/harness-sessions/` JSONL, the stored transcript shape, the `attachments` sidecar, and the `loom_user_stop` entry projector are all dropped. A library keeps one durable store; old session files are ignored, not migrated. Design the clean path, not a reader for what exists.

---

## 4. Dependency changes

| Dependency | Now | After | Note |
|---|---|---|---|
| `@earendil-works/pi-ai` | 0.85.1 | 1.1.0 | `createModels` / `createProvider` move under `/models`; verify API-factory paths |
| `@earendil-works/chord` | 0.85.1 | 1.1.0 | `BACKGROUND_CONTEXT`, `Context` from `@earendil-works/chord/context` |
| `@earendil-works/pi-durable` | — | vendored source | The new harness, vendored as `vendor-pi-durable/src`; subpaths mapped via `#vendor/pi-durable/*`; see Vendoring below |
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
└── vendor-pi-durable/
    ├── UPSTREAM        # repo: .../pi.git, directory: packages/durable, ref, commit
    ├── sync.sh         # mirrors pi packages/durable/src
    └── src/            # copied pi source, available for modification
```

`sync.sh` mirrors `packages/durable/src/` (`rsync --delete`, excluding `**/*.test.ts`, `**/testing/**`, `benchmark/**`), records the ref and commit in `UPSTREAM`, and defaults to `v1.1.0`. `UPSTREAM.directory` becomes `packages/durable`.

Entry points: map the durable subpaths Loom uses through `imports` / tsconfig:

- `#vendor/pi-durable` → `vendor-pi-durable/src/index.ts`
- `#vendor/pi-durable/tools` → `vendor-pi-durable/src/tools/index.ts`
- `#vendor/pi-durable/env/node` → `vendor-pi-durable/src/env/node.ts`
- `#vendor/pi-durable/images/node` → `vendor-pi-durable/src/images/node.ts`
- `#vendor/pi-durable/storage/sqlite/node` → `vendor-pi-durable/src/storage/sqlite/node.ts`
- `#vendor/pi-durable/storage/jsonl/node` → `vendor-pi-durable/src/storage/jsonl/node.ts`

Application code still imports only `@loom/agent`; keep the single boundary (`pi-adapter.ts` or a new `durable-adapter.ts`).

External deps stay npm and align with durable's version: `@earendil-works/chord` 1.1.0, `@earendil-works/pi-ai` 1.1.0, `typebox`, `diff`, and add `@silvia-odwyer/photon` (durable's image processor uses it, not `photon-node`). pi-agent-core is no longer needed.

The vendor-branch rules are unchanged: `vendor-clean` holds pristine source, `main` carries local changes, sync only on `vendor-clean`, and Loom-owned additions go in `src/`, not `vendor-pi-durable/src/` (where the next sync deletes them).

Because durable is Experimental and changes quickly, expect more merge churn than the old harness. Vendoring also makes telemetry approach B (§8) available: instrument the vendored generation/tool tasks directly.

---

## 5. File-by-file mapping

| File | Old dependency | New approach |
|---|---|---|
| `pi-adapter.ts` | `convertToLlm`, `AgentMessage` | Keep `buildChatModels` (pi-ai 1.1.0). `convertToLlm` / `toProviderMessages` are gone: durable entries carry `model: Message[]` directly, so attachment folding moves to submit time |
| `pi-tools.ts` | `AgentHarnessTool`, `createReadTool({imageProcessor})`, `createBashTool({prepare})`, `ExecutionToolContext` | Use durable `createCodingTools()` / `createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool`; rewrite `toHarnessTool` as `defineTool` (`execute(args, api, context)` → `{ output, details }`). Bash `prepare` becomes `BashExecution {command, cwd, env, inheritEnv}` + `api` + `context`; adapt `prepareSandboxedBash`. `ExecutionToolContext` / `setCwd` disappear: env is built per call by `HarnessOptions.env` from the conversation `cwd` |
| `read-image.ts` | `ReadImageProcessor` / `ReadImageProcessorResult` | Replace with durable `ImageProcessor.prepare(bytes, mimeType, limits) → PreparedImage`; use `createNodePhotonImages()` and delete the file |
| `library-skills.ts` | `loadSkills`, `formatSkillsForSystemPrompt` | No equivalent export; self-host over the durable `ExecutionEnv`, or port coding-agent `core/skills.ts`. Inject the catalog as a prompt `section` |
| `library-auto-memory.ts` | `AgentHarnessTool`, `ExecutionToolContext` | Type-only swap to `defineTool` + `ToolExecutionApi`. Inject the note as a `section` / `instructions` |
| `agent-instructions.ts` | — | Map to per-conversation `instructions` (rendered as the `instructions` section) |
| `specialist.ts` | `AgentHarness` + `MemorySessionRepo` | Drop the per-specialist in-memory harness; use durable owned subagents: `api.commit(tx => tx.createConversation({ownership:{kind:"task",taskId:api.taskId}}))` + `api.conversation(child).submit().wait()` |
| `harness-session-manager.ts` | `JsonlSessionRepo`, `AgentHarness.create`, `lane.accept/drive/followUp/abort/resume`, `hooks.on`, `events.on`, `estimateContextTokens`, `laneConfig/laneState/value` | Full rewrite — see §6 |
| `run-trace.ts` / `trace-io.ts` | `withTelemetryContext`, pi-telemetry spans | Rebuild from `watchEvents` + generation/tool hooks, or drop — see §8 |
| tests / evals | `AgentHarness`, `JsonlSessionRepo`, `NodeExecutionEnv`, `estimateTokens`, `findCutPoint`, `span-io` | Rewrite; `BACKGROUND_CONTEXT` moves to `@earendil-works/chord/context` |

---

## 6. Session manager: replace, not port

The old `HarnessSessionManager` owned lanes, sessions, recovery, and event translation. Durable splits those responsibilities across the `Harness`, `Conversation`, tasks, and views; a durable-shaped owner should delegate to them rather than reimplement. The old-API-to-durable checklist:

| Now | Durable |
|---|---|
| `JsonlSessionRepo({ fileSystem, sessionsRoot })` | `openNodeSqliteStorage(file)` (recommended; JSONL keeps the full history in memory) or `openNodeJsonlStorage(dir)` — the Node SQLite adapter uses `node:sqlite`, see §9 |
| `AgentHarness.create({ session, models, model, tools, toolContext, systemPrompt, toProviderMessages, compaction, ... })` | `Harness.open(storage, { models, registry, settings, env })` |
| `harness.lane("main")` + `lane.accept({kind:"prompt"})` + `lane.drive()` | `harness.root()` / `harness.conversation(id)` → `conversation.submit({type:"input", content, requestId})` → `submission.wait()` |
| `lane.abort`, `lane.resume`, hand-written recovery | `conversation.abort()`, `harness.resume()`, idempotent `submit` with `requestId` |
| `lane.followUp` / steering | `submit(..., { whenBusy: "steer" \| "followUp" \| "reject" })` |
| `lane.navigateTree` / `repo.fork({ scope:"branch", position:"before" })` | `conversation.fork(at, ...)` exists; **"retarget before a user message" has no direct equivalent** — fork-and-switch or reset |
| `session.setName` / `setValue(ARCHIVED)` | No title/archive concept; self-host in a per-conversation `defineDoc` or entry |
| `session.getValue(laneConfig/laneState)` | `conversation.configure()` / `conversation.agent()` / `harness.inspect()` |
| Session list | `Storage.scanConversations({ ownerConversationId?, order? })`; no `cwd` filter, so "one group per library" needs its own ownership mapping |
| `hooks.on("before_tool", …)` | `defineExtension({ hooks: [hook(ToolTask, { beforeTool: call => … })] })`; `call.id/name/arguments` available; async user approval still works |
| `events.on("message_update" / "thinking_*" / "tool_*" / "usage" / "compaction_*" / "retry_*")` | `watchEvents(harness, conversationId)` `AgentEvent` (`message_update` deltas, `tool_execution_*`, `auto_retry_*`, `compaction_*`, `usage_changed`), or `conversation.watch()` / `viewState()`; rewrite the `LoomAgentEvent` translation |
| `estimateContextTokens` / `calculateContextTokens` | Not exported; use `harness.usage()` / `pi.usage`, or drop the context-percent indicator |
| `entryProjectors: { loom_user_stop }` | A custom entry kind + `entry.model`, or a generation hook |

**Permission waiting** has no durable event. The `beforeTool` hook may await, so the gate works; the waiting state is published by Loom — a Loom `defineDoc` (pending approvals) observed with `watchDoc`, plus a Loom-owned event — because durable's `watchEvents` stream cannot be injected into.

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
| Hot-swappable registry | no | yes (extensions/sections/hooks/wraps) |
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

Two approaches:

- **A. External (recommended).** A telemetry extension (`hook(GenerationTask, …)` + `hook(ToolTask, …)`) plus one `watchEvents` observer per conversation, and a Loom-owned manual-start/end `TelemetryContext` maintaining a span tree keyed by `conversationId` / `taskId` / `callId`. `LoomTraceSpan` and the dev-trace UI stay unchanged if span names/attributes match.
- **B. Fork durable.** Port `harness/telemetry.ts` (schema + `startAiSpan` / `startHarnessSpan` / `recordAiResult`) into durable's generation / tool / compaction tasks. Closer to the old structure, but adds a fork to an experimental package.

Both require re-owning `AI_TELEMETRY_SCHEMA` / `HARNESS_TELEMETRY_SCHEMA` (they live in the old vendor and disappear with it; `pi-telemetry` still provides `defineTelemetrySchema` / `createTypedSpanStarter`), and dropping `withTelemetryContext` — durable does not read telemetry off the chord `Context`.

---

## 9. Decisions

Resolved:

1. **Facade or direct durable types → thin `@loom/agent`.** Forward durable's generic types and handles (`Harness`, `Conversation`, `EntryRecord`, `ConversationView`, `watchEvents`, `defineTool` / `defineExtension` / `section` / `hook` / `defineDoc`); wrap only Loom-specific assembly and policy — tools, prompt sections, skills/memory, the permission gate, Loom documents, and the per-library `Harness` lifecycle. `packages/app` main holds durable handles; IPC and renderer stay on Loom DTOs, so upstream churn does not cross the process boundary. Rule of thumb: forward generic runtime and live handles, wrap Loom-specific and cross-process.
2. **UI input → durable `watchEvents`.** AG-UI is driven by durable `AgentEvent` (one batch per commit, preceded by a `snapshot` on attach), not by `viewState()` / `watch()`. Loom-owned state durable does not emit — pending approvals, dev-trace, follow-up display — rides a Loom channel: a Loom `defineDoc` observed with `watchDoc`, plus Loom-owned events. `LoomAgentEvent` is retired as the transport; its AG-UI mapping moves to the durable stream plus the Loom channel.
3. **Storage backend → SQLite.** One store per library (e.g. `<library>/.loom/loom.sqlite`), replacing the `harness-sessions/` JSONL directory; no old format to honor.
4. **SQLite driver → durable's built-in `node:sqlite`** (`openNodeSqliteStorage`, `DatabaseSync`). No facade, no `better-sqlite3` for durable. `packages/core` keeps `better-sqlite3` for the retrieval store; unifying the two drivers is out of scope. Verify once that Electron 38.2.2's main process exposes `node:sqlite`.

Open:

5. **Session metadata:** per-conversation `defineDoc` (watchable) or plain entries for title / archive?
6. **Specialists:** owned conversations for both retrieve and create, and do create agents become background tasks?
7. **Retarget / branch-before:** drop, or emulate with `fork(at)`?
8. **Telemetry:** rebuild a coarser trace from events + hooks (approach A), fork durable (approach B), or drop dev-trace?

---

## 10. Migration order

1. Decide the facade and UI-input questions (§9 decisions 1–2), then define the durable-shaped owner (`Harness` + `Registry` + Loom `defineDoc`s) and the `@loom/agent` facade.
2. Bump pi-ai / chord to 1.1.0, add pi-durable; confirm the SQLite driver (§9 decision 4), then get `buildChatModels` + `Harness.open` + `submit` / `wait` running.
3. Port the tool layer: `pi-tools`, `read-image` (→ `createNodePhotonImages`, delete old code), `library-auto-memory`; move tools and the prompt into an extension.
4. Replace the session manager with the durable-shaped owner; wire the app to views/events (largest piece).
5. Move specialists to owned subagents.
6. Add skills + prompt sections + session metadata documents.
7. Rebuild tests / evals. No storage migration; old sessions are dropped.
8. Decide telemetry.

---

## 11. Risks

- **Durable is Experimental;** API changes without notice. Pin the version and expect churn.
- **Vendor churn:** vendoring the source means Loom merges frequent upstream changes and owns the fork.
- **SQLite driver:** durable's Node adapter depends on `node:sqlite`, whose availability in Electron 38.2.2 is unverified; see §9 decision 4.
- **No compatibility (by design):** existing `.loom/harness-sessions/` sessions are ignored, not migrated.
- **Behavioral drift:** branch-before / retarget, session title / archive, and context-percent display have no 1:1 durable primitive.
- **Telemetry ownership:** Loom ends up owning the producer that upstream used to ship.

---

## 12. Summary

- Upstream moved the harness out of `packages/agent` into `pi-durable`; the vendored harness is frozen at v0.85.1.
- Durable is a re-architecture with the same core capabilities, not a feature upgrade.
- Durable is vendored as source, replacing `vendor-pi-agent/`; npm deps are pi-ai, chord, photon, typebox, and diff.
- Backward compatibility is dropped: old session storage, transcript shape, attachment sidecar, and projector are not carried over.
- Scope follows durable's model; `packages/app` is in scope, not just `packages/agent`.
- The largest work is replacing the session manager with a durable-shaped owner and wiring the app to durable views/events, then `specialist.ts` and the telemetry rebuild.
- Decided: a thin `@loom/agent` boundary, a `watchEvents`-driven UI, SQLite storage, and durable on the built-in `node:sqlite` (§9). Decide the remaining §9 items before starting.
