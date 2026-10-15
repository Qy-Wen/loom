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

`packages/agent/src` groups by responsibility:

| Responsibility | Modules |
|---|---|
| Native boundary and model configuration | `index`, `durable`, `durable-adapter`, `pi-adapter` |
| Library owner and conversation metadata | `library-agent`, `conversation-metadata`, `session-title` |
| Tools, specialists, permissions | `pi-tools`, `specialist`, `tool-gate`, `tool-permission`, `workspace-path` |
| Prompt sections | `library-extension`, `library-auto-memory`, `library-skills` |
| Composer and send-time context | `attachments`, `composer-asset`, `composer-image` |
| Contracts and context occupancy | `types`, `session-dto`, `context-usage` |
| Diagnostics | `durable-trace`, `trace-models`, `trace-privacy`, `trace-store`, `trace-types` |

Keep runtime scheduling in durable. Instructions use native configuration, attachments fold before submit, and memory/skills use sections; do not retain duplicate provider-time transforms, prompt concatenators, or the old telemetry recorder.

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
- Chat DTOs paginate native fork-aware `conversation.entries()` history, not compacted `context().entries`. Compaction summaries are not user messages. List/record timestamps use the last non-system, non-compaction message.
- Fork-before finds the preceding entry in full history, including a start anchor for the first question and messages removed from model context by compaction. Branch-before creates the fork and archives the source. Closing an empty conversation (no chat messages or pending input) hides it without adding History; conversations with messages are archived. Internal start/system entries do not count as chat; inherited fork messages do. Delete hides the conversation, preserving ancestry and files already written.
- Old `.loom/harness-sessions/` JSONL is ignored, not migrated.

## 4. Tools, specialists, prompt

- `createWorkspaceTools()` returns durable `read`, `bash`, `edit`, and `write`. Environment/cwd is per conversation; bash preparation delegates to the core process sandbox. Images use upstream Photon workers.
- `toDurableTool()` adapts Loom `content` to durable `output`, forwards cancellation, validates JSON `details`, and uses `replay: "unsafe"` for external effects.
- Main and specialist agents share `createToolResultStorage()`, an `afterTool` hook before durable's final truncation. Text over 50 KiB or 2,000 lines is saved in `.agents/tool-results/<conversationId>/<taskId>.txt`; the model gets a UTF-8-safe preview of up to 2 KiB, the full path, and bounded-read instructions. Images, error status, UI details, and structured output are preserved. `read` and results already carrying a `full_output` diagnostic are not saved again. Failed writes warn and fall back to durable truncation. Files remain available across reopen/fork, without automatic expiry; `.agents` is not indexed as assets. Streamed text already discarded before the hook cannot be recovered; shell tools retain their existing spill mechanism.
- Parent chat keeps workspace, FFmpeg, describe/embed, other application tools, and all connected MCP tools. Parent and retrieve share `search_assets` and `inspect_asset`; retrieve also has `read`. Supplied IDs require inspect first, without searching for the same asset; source text is read from the returned `relativePath`. The parent handles a single retrieval task directly, even when it needs multiple steps, and considers retrieve only for multiple independent retrieval tasks that can run in parallel, passing each task's question and needed asset IDs in the goal. Create uses `read`, `edit`, `write`, `bash`, `inspect_asset`, the FFmpeg media tools, and the same MCP tools as the parent. It has no `search_assets`, describe/embed, property, relation, or settings tools. The parent chooses direct MCP calls or delegation to create based on the task. All use the same permission gate; retrieve has no MCP tools.
- Each specialist tool creates a foreground task-owned conversation. Independent calls can run together. The child sees only its goal and specialist prompt; it cannot spawn another specialist. Parent receives the summary, not the child transcript. Stop cascades through ownership. Request IDs make safe specialist replay reuse its child/submission.
- `createLibraryExtension()` assembles tools and preamble/skills/memory sections. User instructions use native `agent.instructions`.
- Skills scan only `.agents/skills/`, via durable `ExecutionEnv`, on request preparation. Discovery honors scoped ignore files, diagnoses invalid/duplicate metadata, and skips symlinks. The catalog contains name/description/location, never bodies; the model uses `read` on demand. `disable-model-invocation` removes a skill from the catalog.
- Memory is a creation-time `LoomMemoryDoc` snapshot, retained on forks/reopen. `auto_memory` writes `.agents/memory/MEMORY.md` immediately but affects only later conversations' prompts. Specialists do not select this extension. See [MEMORY](./MEMORY.md).
- Permission uses a cancellable `ToolTask.beforeTool` hook and `LoomApprovalsDoc`; the app watches pending rows. Remembered command rules and sandbox policy are in [PERMISSION](./PERMISSION.md).

## 5. Send-time context

Placed files become `<asset_ref>` blocks in user text. Implicit selection becomes `<ui_selection>` inside a `<system-reminder>` after the words. Fold once **before submit**, then persist the resulting model content unchanged; no attachment sidecar or provider-time conversion is required.

`loom.user` entry data keeps display text, so bubbles omit the implicit reminder. Pictures are model image content. Repeated selection is detected in persisted folded content; existing messages are never rewritten. Asset refs copy stable IDs and library-relative paths; clicking resolves the current asset by ID, falling back to path.

MCP forwards content blocks to the same `toDurableTool()` adapter as application tools: text/images remain native output; other blocks become JSON text. Durable applies its common text limits (2,000 lines / 50 KiB); images have no common size cap. There is no MCP-specific media processing, truncation, or file cache. AG-UI carries image results as serialized content blocks for live events and history snapshots. Tool cards show images separately from text, without printing base64 data. Text-only tool results keep their existing representation.

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

Partial updates are not only string deltas: durable also publishes whole messages and whole content blocks. Keep a per-block partial state and emit only the unseen text/thinking suffix. Initial snapshots preserve the optimistic user row until admission; otherwise the renderer's history/live merge hides the streaming continuation. Tool call IDs are namespaced by conversation in both live events and saved DTOs. When historical reasoning IDs differ from live IDs, a shared saved tail anchors subsequent increments after user admission; otherwise later turns show only a waiting dot. Acceptance covers first/later chunks across three consecutive turns and two real-model turns.

CopilotChat receives an explicit `threadId`, enabling native reconnect rather than manually claiming a random agent thread. Editing an earlier question forks and switches first, then submits once through the current CopilotChat send callback after the new thread connects; it does not reuse the old callback or force-replace live messages. Reload while a child waits for approval replays its card and pending state. Child tool/approval watchers attach through persisted specialist details and restore from their snapshots. Child text stays out of parent model history. Follow-ups use native `whenBusy: "followUp"`; Stop drops unadmitted inputs and aborts foreground owned work.

`DurableAgentRunner` routes run/connect/stop to the adapter and native submissions; it does not use CopilotKit's in-memory history. Transport detach stops a connect watcher, not durable work; explicit Stop aborts the matching run. Connect restores partials, tools, and child approvals from durable snapshots and chat history from full entries, including after a main-process crash. Reconnecting a completed submission does not wait for a new run-end, even if its answer was compacted.

After SIGKILL, a streaming request is resent from its committed checkpoint. Interrupted partial text remains as `aborted` history but is excluded from the resent model context. An executing unsafe tool is not replayed and reports that it may have partially run. OS children may survive independently; external effects are not guaranteed exactly-once.

Main binds HTTP to `127.0.0.1` on a random port, permits Electron/local renderer origins, and closes on quit. Only AG-UI crosses this boundary. Development traces use a Loom extension/commit observer and public model-call instrumentation, persisted at `.agents/traces/traces.sqlite`; the Traces window reads history and live revisions. See [TRACE](./TRACE.md) for timing, privacy, recovery, and validation boundaries.

The context ring estimates current-model window occupancy; click for `~percent / window`. `contextUsage()` reads native active `ContextView`, uses applicable current-provider/model assistant usage after the latest head (including cache and output), then estimates trailing messages. Without applicable usage after creation, compaction, or model changes, it estimates active messages, including system/tool schemas/images, not full chat history or cumulative spend. Committed messages, compaction, and model settings changes refresh it; unconfigured Chat hides it. The model window comes from settings, defaulting to 128k; this is not an exact tokenizer measurement.

## 7. Validation

Agent/app typechecks and unit suites pass; vendor source/compiled-worker checks pass. Electron acceptance covers persistence, specialist approvals, post-compaction reload/old-message forks, and SIGKILL/restart during approval, streaming, and external bash execution. It checks unduplicated user inputs, no unsafe tool replay, and text visible **before** model completion. Optional live acceptance:

```bash
cd packages/app
LOOM_E2E_LIVE_CHAT=1 node --env-file=../../.env node_modules/@playwright/test/cli.js test live-chat.spec.ts
```

DeepSeek live streaming, compaction anchor recall, and prompt-cache evals pass. After aligning retrieve instructions and inspect mock fields with the product, strict live tool gold passed 4/4 twice without relaxing gold. Windows on-device validation and controlled old/new eval comparisons remain; no claim of complete parity. See [EVALS](./EVALS.md) for results and limitations.
