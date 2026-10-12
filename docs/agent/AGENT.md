**English** | [简体中文](./AGENT.zh-CN.md)

# Agent Architecture

Loom's creative-asset agent runs on vendored `pi-durable`. Model/provider integration uses npm `pi-ai`; AG-UI is the frontend protocol. See [MIGRATION](./MIGRATION.md), [EVALS](./EVALS.md), [MEMORY](./MEMORY.md), and [PERMISSION](./PERMISSION.md).

## 1. Boundaries

```
Renderer: CopilotChat + Loom session/tool views
    │ IPC (plain DTOs) / localhost HTTP SSE (AG-UI)
Main: LibraryAgentHost + DurableAgentRunner + LoomAgUiAgent
    │ @loom/agent
Loom: LibraryAgent + extensions/documents/tool adapters
    │ durable-adapter.ts
Vendor: pi-durable + pi-codemode
    │ pi-ai models / chord / node:sqlite
```

- `packages/agent/src/durable-adapter.ts` is the only vendor import boundary. `@loom/agent` and `@loom/agent/durable` forward native handles and add Loom assembly/policy.
- Main holds `Harness`, `Registry`, and `Conversation` handles. IPC exposes `LoomSessionRecord` / `LoomSessionSummary`; IDs are decimal strings. Renderer never holds durable handles.
- Durable owns scheduling, inboxes, retry, compaction, task cancellation, and recovery. Loom does not recreate lanes or a session manager.
- Retrieval/index storage remains separate in `packages/core`.

## 2. Vendor workflow

`vendor-pi-durable/src` and `vendor-pi-codemode/src` mirror upstream `main` from the same commit. Each `UPSTREAM` records provenance. External model/runtime dependencies remain npm; codemode is a private workspace retaining upstream imports.

```bash
git checkout vendor-clean
pnpm vendor:sync                 # optionally specify a ref
git add packages/agent/vendor-pi-durable packages/agent/vendor-pi-codemode
git commit -m "vendor: sync pi durable main"
git checkout main
git merge vendor-clean
```

Sync requires `vendor-clean`, uses one temporary clone, excludes tests/testing/benchmarks, and supports macOS and native Windows. Keep Loom-owned code outside both vendor `src/` trees; no upstream-source edits are needed for integration.

## 3. Library ownership and persistence

- `LibraryAgent.open(root, options, context)` opens `<library>/.loom/loom.sqlite` with `node:sqlite`, creating one Harness and Registry. Close delegates to durable and leaves unfinished tasks recoverable.
- Canonical-path reservation prevents duplicate owners within a process. Electron uses an app single-instance lock; other programs must not open the same store as a second active owner. WAL is not owner coordination. Windows runtime validation remains pending.
- `LibraryAgentHost` installs resources before `resume()`, clears stale approval documents, records the usage baseline, then resumes native recovery.
- New independent conversations receive library cwd and current Chat/instruction defaults. Forks retain as-of agent configuration. Model/instruction edits configure existing conversations and update defaults for subsequent chats; tools replace registry extensions in place.
- `LoomConversationDoc` stores latest title/archive/hidden/creation metadata outside model context. Forks append `（分支）`, clear archive/hidden, and leave the source unchanged.
- Fork-before uses the preceding entry, including a start anchor for the first question. Branch-before creates the fork and archives the source. Delete hides the conversation, preserving ancestry and files already written.
- Old `.loom/harness-sessions/` JSONL is ignored, not migrated.

## 4. Tools, specialists, prompt

- `createWorkspaceTools()` returns durable `read`, `bash`, `edit`, and `write`. Environment/cwd is per conversation; bash preparation delegates to the core process sandbox. Images use upstream Photon workers.
- `toDurableTool()` adapts Loom `content` to durable `output`, forwards cancellation, validates JSON `details`, and uses `replay: "unsafe"` for external effects.
- Parent chat keeps workspace, FFmpeg, describe/embed, and other application tools. Retrieve owns `search_assets`, `inspect_asset`, and `read`. Create owns MCP `server__tool`, `write`, and `bash`.
- Each specialist tool creates a foreground task-owned conversation. Independent calls can run together. The child sees only its goal and specialist prompt; it cannot spawn another specialist. Parent receives the summary, not the child transcript. Stop cascades through ownership. Request IDs make safe specialist replay reuse its child/submission.
- `createLibraryExtension()` assembles tools and preamble/skills/memory sections. User instructions use native `agent.instructions`.
- Skills scan only `.agents/skills/`, via durable `ExecutionEnv`, on request preparation. Discovery honors scoped ignore files, diagnoses invalid/duplicate metadata, and skips symlinks. The catalog contains name/description/location, never bodies; the model uses `read` on demand. `disable-model-invocation` removes a skill from the catalog.
- Memory is a creation-time `LoomMemoryDoc` snapshot, retained on forks/reopen. `auto_memory` writes `.agents/memory/MEMORY.md` immediately but affects only later conversations' prompts. Specialists do not select this extension. See [MEMORY](./MEMORY.md).
- Permission uses a cancellable `ToolTask.beforeTool` hook and `LoomApprovalsDoc`; the app watches pending rows. Remembered command rules and sandbox policy are in [PERMISSION](./PERMISSION.md).

## 5. Send-time context

Placed files become `<asset_ref>` blocks in user text. Implicit selection becomes `<ui_selection>` inside a `<system-reminder>` after the words. Fold once **before submit**, then persist the resulting model content unchanged; no attachment sidecar or provider-time conversion is required.

`loom.user` entry data keeps display text, so bubbles omit the implicit reminder. Pictures are model image content. Repeated selection is detected in persisted folded content; existing messages are never rewritten. Asset refs copy stable IDs and library-relative paths; clicking resolves the current asset by ID, falling back to path.

## 6. AG-UI and live rendering

`LoomAgUiAgent` extends `AbstractAgent`; clones retain the host and shared run lifecycle. `watchEvents` provides an atomic `stream.snapshot` separately from later commit batches; consume both.

| Durable / Loom state | AG-UI |
|---|---|
| Input submission / settlement | `RUN_STARTED`, `RUN_FINISHED` / `RUN_ERROR` |
| `message_start`, `message_update` | text/reasoning increments |
| Committed entry | `loom.user_entry`, `loom.adopt_entry` |
| `tool_execution_*` | tool start/args/end/result, progress activity |
| Approval document | `loom.tool_gate` activity |
| Tool result details | `loom.tool_result` custom event |
| Retry / compaction | retry activity / compaction custom event |
| Attach / completion | messages snapshot |

Partial updates are not only string deltas: durable also publishes whole messages and whole content blocks. Keep a per-block partial state and emit only the unseen text/thinking suffix. Initial snapshots preserve the optimistic user row until admission; otherwise the renderer's history/live merge hides the streaming continuation. Tool call IDs are namespaced by conversation in both live events and saved DTOs.

CopilotChat receives an explicit `threadId`, enabling native reconnect rather than manually claiming a random agent thread. Reload while a child waits for approval replays its card and pending state. Child tool/approval watchers attach through persisted specialist details and restore from their snapshots. Child text stays out of parent model history. Follow-ups use native `whenBusy: "followUp"`; Stop drops unadmitted inputs and aborts foreground owned work.

`DurableAgentRunner` routes run/connect/stop to the adapter and native submissions; it does not use CopilotKit's in-memory history. Transport detach stops a connect watcher, not durable work; explicit Stop aborts the matching run. Connect restores history, partials, tools, and child approvals from durable snapshots, including after a main-process crash.

Main binds HTTP to `127.0.0.1` on a random port, permits Electron/local renderer origins, and closes on quit. Only AG-UI crosses this boundary. Context percentage is temporarily absent. Telemetry production is deferred; dev-trace types/UI remain but emit no spans.

## 7. Validation

Agent/app typechecks and unit suites pass; vendor source/compiled-worker checks pass. Electron acceptance covers persistence, specialist approval, reload/fork, SIGKILL/restart of an approval-blocked child without duplicate model calls, and text visible **before** model completion. Optional live acceptance:

```bash
cd packages/app
LOOM_E2E_LIVE_CHAT=1 node --env-file=../../.env node_modules/@playwright/test/cli.js test live-chat.spec.ts
```

DeepSeek live streaming, compaction anchor recall, and prompt-cache evals pass. The strict live tool gold set is currently 3/4: the chip task sometimes uses `read` without required `inspect_asset`. This is not a passing parity claim. See [EVALS](./EVALS.md) for results and limitations.
