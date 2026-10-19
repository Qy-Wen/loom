**English** | [简体中文](./AGENT.zh-CN.md)

# Agent Architecture

Loom's creative-asset agent runs on vendored `pi-durable`. Model/provider integration uses npm `pi-ai`; AG-UI is the frontend protocol. See [MIGRATION](./MIGRATION.md), [EVALS](./EVALS.md), [MEMORY](./MEMORY.md), and [PERMISSION](./PERMISSION.md).

Chat provider/catalog/auth, provider login, and per-conversation model selection are live; see [CHAT_MODELS](./CHAT_MODELS.md).

## 1. Boundaries

```
Renderer: CopilotChat + Loom session/tool views
    │ IPC (plain DTOs) / localhost HTTP SSE (AG-UI)
Main: ChatService + DurableAgentRunner + AgUiAdapter
    │ @loom/agent
Loom: LibraryRuntime + extensions/documents/tool adapters
    │ durable-adapter.ts
Vendor: pi-durable + pi-codemode
    │ pi-ai models / chord / node:sqlite
```

- `packages/agent/src/durable-adapter.ts` is the only vendor import boundary. `@loom/agent` and `@loom/agent/durable` forward native handles and add Loom assembly/policy.
- Main holds `Harness`, `Registry`, and `Conversation` handles. IPC exposes `LoomSessionRecord` / `LoomSessionSummary`; IDs are decimal strings. Renderer never holds durable handles.
- Durable owns scheduling, inboxes, retry, compaction, task cancellation, and recovery. Loom does not recreate lanes or a session manager.
- Retrieval/index storage remains separate in `packages/core`.

`LibraryRuntime` owns one library's Harness, Registry, and storage. App-scoped `ChatService` opens/closes that runtime and owns input preparation/submission, permissions, defaults, history DTOs, and notifications. `AgUiAdapter` and `DurableAgentRunner` handle the frontend protocol and connection lifecycle through the service. Connections retain their original library runtime when the app switches libraries. Parent/specialist extension assembly is shared with headless evaluations through `createChatExtensions()`.

`packages/agent/src` groups by responsibility:

| Responsibility | Modules |
|---|---|
| Native boundary and model configuration | `index`, `durable`, `durable-adapter`, `chat-provider` |
| Library owner and conversation metadata | `library-runtime`, `conversation-metadata`, `session-title` |
| Tools, specialists, permissions | `pi-tools`, `chat-extensions`, `specialist`, `tool-gate`, `tool-permission`, `workspace-path` |
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

- `LibraryRuntime.open(root, options, context)` opens `<library>/.loom/loom.sqlite` with `node:sqlite`, creating one Harness and Registry. Close delegates to durable and leaves unfinished tasks recoverable.
- Canonical-path reservation prevents duplicate owners within a process. Electron uses an app single-instance lock; other programs must not open the same store as a second active owner. WAL is not owner coordination. Windows runtime validation remains pending.
- `ChatService` installs resources before `resume()`, clears stale approval documents, records the usage baseline, then resumes native recovery.
- New independent conversations receive library cwd and current Chat/instruction defaults. Forks retain as-of agent configuration. Default models fill new or unselected conversations; existing conversations keep their saved selection, and each conversation can switch its model/thinking in the composer toolbar (rejected while busy, effective from the next request). Tools replace registry extensions in place.
- `LoomConversationDoc` stores latest title/archive/hidden/creation metadata outside model context. Forks append `（分支）`, clear archive/hidden, and leave the source unchanged.
- Chat DTOs paginate native fork-aware `conversation.entries()` history, not compacted `context().entries`. Compaction summaries are not user messages. List/record timestamps use the last non-system, non-compaction message.
- Fork-before finds the preceding entry in full history, including a start anchor for the first question and messages removed from model context by compaction. Branch-before creates the fork and archives the source. Closing an empty conversation (no chat messages or pending input) hides it without adding History; conversations with messages are archived. Internal start/system entries do not count as chat; inherited fork messages do. Delete hides the conversation, preserving ancestry and files already written.
- Legacy directories under `.loom/` are ignored: neither read nor deleted.

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

`ChatService.prepareTurn()` consumes staged inputs, folds context, validates empty input, and initializes the title for both ordinary turns and queued follow-ups. Admission waits until the transport observer is attached. Replaying an existing request reuses its submission without consuming the next draft.

`loom.user` entry data keeps display text, so bubbles omit the implicit reminder. Explicit JPEG/PNG/GIF/WebP chips also attach native image content (up to 4, 8 MiB each) to prompts and queued follow-ups; bytes are resolved by live library ID before sending. Other formats remain references. Text-only models receive pi-ai's image-omitted placeholder. Clipboard screenshots without a disk path are imported into `Inbox/` before becoming chips. Removing a chip removes its image from the next message. Repeated selection is detected in persisted folded content; existing messages are never rewritten. Asset refs copy stable IDs and library-relative paths; clicking resolves the current asset by ID, falling back to path.

MCP uses the official SDK and discovers every tool-list page before caching output schemas and task requirements. Embedded text/image resources are unwrapped; when `content` is empty, `structuredContent` becomes JSON text. Existing content takes precedence over structured fallback. Results then use the same `toDurableTool()` adapter as application tools: text/images remain native output; other blocks become JSON text. MCP `isError` becomes a tool failure using readable text; cancellation reaches the server and late results are discarded.

Durable applies its common text limits (2,000 lines / 50 KiB); images have no common size cap. There is no MCP-specific media processing, truncation, or file cache. Original images remain in durable history for model input. UI history and live tool results carry only `loom-asset://chat-image/<conversation>/<entry>/<contentIndex>` references; tool cards load the bytes on demand instead of transporting base64 through IPC/SSE. Text-only tool results keep their existing representation.

## 6. AG-UI and live rendering

`AgUiAdapter` extends `AbstractAgent`; clones retain the chat service and shared connection lifecycle. `ag-ui-events.ts` translates durable events, including partial text/reasoning, child tools, and approvals, independently of submission and subscription management. `watchEvents` provides an atomic `stream.snapshot` separately from later commit batches; consume both.

| Durable / Loom state | AG-UI |
|---|---|
| Input submission / settlement | `RUN_STARTED`, `RUN_FINISHED` / `RUN_ERROR` |
| `message_start`, `message_update` | text/reasoning increments |
| Committed entry | `loom.user_entry`, `loom.adopt_entry` |
| `tool_execution_*` | tool start/args/end/result, progress activity |
| Approval document | `loom.tool_gate` activity |
| Tool result details | `loom.tool_result` custom event |
| Retry / compaction | retry activity / compaction custom event |
| Attach / reconnect | Snapshot of active work and unadmitted input only |
| Completion | `loom.history_changed`, requesting newly committed entries |

History and live state are separate. `useSessions` initially loads full history over IPC, then requests entries after the last committed ID. It coalesces concurrent refreshes and rejects stale results after switching conversations or libraries. SSE does not send saved history; completion only invalidates it. Send requests contain only the current user message; durable builds model context.

Partial state is maintained per block, emitting only unseen text/thinking suffixes. User admission persists the client message ID; assistant adoption renames both answer and reasoning IDs. History/live reconciliation uses IDs, with committed content authoritative while retaining live specialist calls. It never guesses from text, list lengths, or historical tails. Follow-ups also use client IDs to reconcile queued/admitted state. Tool call IDs are always namespaced by conversation.

In the renderer, `session-chat` assembles session and branch actions; `use-sessions` owns selection and committed history, `use-chat-stream` owns live ID adoption and submission boundaries, `chat-composer` / `chat-composer-input` own input and attachments, and `chat-messages` / `chat-scroll` own display and scroll following.

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
