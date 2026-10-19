**English** | [简体中文](./ARCHIVE.zh-CN.md)

# Archive

Completed milestones are recorded here. See the current [TODO](../TODO.md).

---

## Dead code and shared-function cleanup

Removed `NoopGraphHandlers`, the app's obsolete message-derived usage functions and tests, and unused imports and bindings. Evaluations retain their own `usageFromMessage()`. The graph view reuses `graphBounds()`; approval span creation and Markdown callback argument positions are preserved.

macOS validation: Core, Agent, and App typechecks passed with `noUnusedLocals` / `noUnusedParameters`; 139, 153, and 316 tests passed respectively, with two Windows cases skipped in Core. Core's directory-rename watcher test timed out on the first run; the full package passed on rerun.

---

## MCP results and transport contracts

MCP uses the official SDK. Tool discovery aggregates all pages before SDK caching, preserving output-schema validation and task requirements for every page. Repeated cursors and excessive pagination fail explicitly; connection or discovery failures close the session.

Embedded text and image resources become native content. Empty `content` falls back to JSON from `structuredContent`; existing content takes precedence, and other blocks retain the common tool adapter's JSON representation. `isError` reports readable text. Cancellation reaches the server; pre-aborted calls are not dispatched and late results are discarded. Client replacement is no longer a standalone backlog item; evaluate authorization integration and client choice when MCP OAuth is needed.

macOS validation passed: workspace typecheck, 139 Core tests (2 skipped), 153 Agent tests, 317 App tests, and the app build. App includes five real-SDK contracts each for stdio and Streamable HTTP covering pagination, validation, content, errors, and cancellation. Two Electron cases verify ordinary and embedded images reach the model and display live, after reload, and on a branch.

---

## Chat runtime, service, and protocol boundaries

`LibraryRuntime` owns the library's Harness, Registry, and storage. `ChatService` centralizes ordinary/queued input preparation and submission, permissions, defaults, DTOs, and notifications. `AgUiAdapter` owns connection lifecycle; `ag-ui-events.ts` translates durable events without submitting work. `DurableAgentRunner` delegates running/stop checks to the service. Library switches cannot redirect old connections into the new runtime. Applications and evaluations share parent/specialist extension assembly through `createChatExtensions()`.

macOS validation passed: workspace typechecks/unit tests, production and trace builds, 34 durable contracts, four offline agent/tool evaluations, and 27 relevant Electron tests including trace restart. Added focused coverage for input replay, library-switch isolation, interleaved stream blocks, and child tool/image events. Trace acceptance explicitly selects the configured model for its existing startup conversation.

---

## Composer image input

Explicit JPEG/PNG/GIF/WebP attachments keep their library chips and send native image blocks through pi-ai, including queued follow-ups and edited questions. Clipboard screenshots without paths import into `Inbox/`. Image bytes stay in durable history; renderer records use media URLs. The unused image-staging IPC and old image-only names/styles are removed. See [AGENT](../agent/AGENT.md).

macOS validation: workspace typecheck, app build, 301 app unit tests, six composer Electron tests, and the existing read/MCP image Electron tests passed. Composer tests cover paste, drop, both file pickers, edits, queued follow-ups, text-only models, history reload, and subsequent text without stale images.

---

## Parallel conversations with independent models

Windows Electron tests use isolated user data and controlled local SSE servers. Different models from one provider and identically named models from different providers each passed three repeats: six tests passed, alongside the App typecheck.

Coverage includes overlapping requests; endpoint/model/credential routing; isolated history and tool results with repeated raw tool-call IDs; independent usage/windows; busy model-change rejection; idle model changes while another stream runs; per-conversation cancellation/failure; reload/reconnect; full process restart and continued parallel chat; and forked model selection. Other native services and the cross-protocol matrix remain pending.

Reproduce: `pnpm --filter @loom/app exec playwright test e2e/parallel-chat.spec.ts --repeat-each=3` (build the app first).

---

## Windows Chat acceptance

Acceptance date: 2026-10-17.

Environment: Windows x64, Node 22.23.3, Electron 38.2.2, pi-ai 1.1.0. Electron tests use isolated temporary user data and libraries.

| Check | Result |
| --- | --- |
| Workspace/vendor typechecks and app build | Passed |
| Core unit tests | 140 passed, 1 skipped |
| Agent unit tests | 153 passed |
| App unit tests | 296 passed |
| Vendor contracts | 34 passed |
| Full Electron regression | 73 passed, 8 skipped, 1 panel-drag timeout; three isolated repeats and all 43 panel tests passed on rerun, without reproducing the timeout |
| `check:chat-platform` | OS encryption/cross-process decrypt, mock OAuth callback validation/cancellation, and four lazy SDKs passed |
| Live native DeepSeek | Two native requests and two-turn Electron chat, usage, reopened history, and model selection passed |

To reproduce DeepSeek acceptance, set `LOOM_E2E_LIVE_CHAT=1` and run `pnpm --filter @loom/app exec playwright test e2e/live-chat.spec.ts --grep "native DeepSeek provider"`. It uses `DEEPSEEK_API_KEY` from the workspace environment and caps each response at 64 tokens. Mock callbacks do not replace real OAuth authorization acceptance.

The eight skipped tests require either a dedicated panel build (six) or an explicit live-request opt-in (two); the native DeepSeek case was enabled and passed separately. The panel timeout remains recorded as intermittent, so the full run is not reported as a clean pass.

---

## Agent model configuration

The Agent can use `get_settings` / `update_settings` to inspect and configure Chat providers and models, plus request URLs, models, API keys, and enablement for Embedding, Rerank, VLM, and Audio. Reads omit keys, and the UI synchronizes after changes. Basic and Standard require user approval before writes. See [SETTINGS](../SETTINGS.md).

---

## Publishing via MCP

Publishing to Xiaohongshu, Douyin, and other platforms connects through MCP servers, with the Agent calling the corresponding MCP tools. Loom uses its existing MCP connections, tool registration, and permission controls.

---

## Chat integration with pi-ai and per-conversation model selection

Production Chat uses native pi-ai Providers, model catalogs, protocols, and API-key/OAuth login, with OS-encrypted credentials. Settings supports built-in and custom providers, protocol inference from complete request URLs, model enablement, and key editing; `get_settings` / `update_settings` can inspect and change Chat configuration. Legacy Chat endpoints and compatibility paths are removed. See [CHAT_MODELS](../agent/CHAT_MODELS.md) and [SETTINGS](../SETTINGS.md).

Each conversation persists its own model and thinking level, retained across reopening and forks. The composer model menu lists only enabled, available models, with thinking levels in a model submenu. Busy conversations reject changes; selections apply from the next request. New independent conversations inherit the last explicit choice only while it remains enabled and available, without automatic replacement.

---

## Packaging

One `pnpm dist` on a Mac produces the macOS arm64, macOS x64, and Windows x64 installers. A release uploads them with local `gh` to a GitHub Release. Versions start at `v0.1.0` and increment the patch number. The installers are unsigned, and GitHub Actions is not used. See [PACKAGING](../PACKAGING.md).

---

## Graph retrieval

On a text query, after RRF fuses full-text and vector candidates and before rerank, walk one `RELATED` hop both ways from each candidate. A neighbor is its own row, with `linkedFrom` (candidate id, relation type, direction from that candidate). An id already in the list is not repeated. At most 8 neighbors per candidate. Type and property filters stay on the original candidates. The rerank document is still the passage, parent passage, or filename. Rows that rerank or the `limit` drop are not added back. A query with no text does not walk the graph. When the retrieve specialist names a connected file, it writes an `<asset_ref>` and the relation type. See [TEXT](../RAG/TEXT.md).

---

## Finer permissions

Approving a tool can remember that command for the open library, in `<library>/.loom/command-allows.json`, not in app user data. Another library does not use it. `bash` stores the command text with the ends trimmed. `run_ffmpeg` stores the program and its arguments. `write` and `edit` store the tool and the path, not the file contents. Other gated tools store the tool name. Settings → Agent can forget one. Choosing Full asks once more: the sandbox does not apply this time, and the agent can run every operation. The sandbox switch stays as saved. See [PERMISSION](../agent/PERMISSION.md).

---

## Observability

One prompt's run, turn, step, tool, and model-request spans stay in memory, on Pi's existing telemetry. In development, a separate Traces window shows each prompt as a span waterfall. Click a tool or model span to read its arguments and result, or the messages sent and the reply. Each side is truncated. That window is not part of the packaged app. Lifetime Stats stay in Settings.

---

## Process sandbox

`bash`, `ffmpeg`, and `ffprobe` run in a process sandbox by default. They can write the open library and the temp directory. The user profile is not readable, then the library, the temp directory, and the directories of the shell, ffmpeg, and ffprobe are allowed again. Those processes have no network. Settings → Agent can turn it off. Full permission runs them directly, and leaving Full restores the switch. `read`, `edit`, and `write` stay in-process. Generation stays MCP and is not wrapped in this sandbox. See [PERMISSION](../agent/PERMISSION.md).

---

## Auto memory

Facts for the open library live in `<library>/.agents/memory/MEMORY.md`. The folder is created on open and is not indexed. A session reads the note once, after the skills catalog, and keeps that snapshot. `auto_memory` adds, replaces, and removes entries immediately. About 2,000 characters; past that, the tool returns an error and the current entries. Procedures stay in skills. Retrieve and create specialists do not get the tool. See [MEMORY](../agent/MEMORY.md).

---

## Multi-agent

The chat Agent talks, plans, and transforms. `run_retrieve_agent` searches and inspects the library. `run_create_agent` generates from a brief via MCP and does not search. Asset ids go in the brief when the task needs them. Independent calls in one turn run together. A specialist cannot start another specialist. See [AGENT](../AGENT.md).

---

## Human in the loop

Chat footer: Basic, Standard (default), Full. Stored in app userData, not the library. Standard waits on `write` / `edit` outside the open library and writes inside it directly. Basic also waits on `bash` and the FFmpeg tools that write a file. `get_media_info` does not wait. Full does not wait on tools and does not sandbox; choosing Full asks once more. Remembered commands are under Finer permissions above. See [PERMISSION](../agent/PERMISSION.md).

---

## Agent and retrieval evals

In-repo gold sets, no second repository. Retrieval and Agent/tool gold, CI stub vs live slots. See [EVALS](../AGENT/EVALS.md).

---

## Library skills

On library open, scan `<library>/.agents/skills/` for Agent Skills (`SKILL.md`). The system prompt gets the name / description / location catalog. The model uses `read` for the body and relative files. Loom does not create that folder, scan the rest of the library, or add skill slash-commands. Do not vendor `packages/coding-agent`. See [AGENT](../AGENT.md) and [agentskills.io](https://agentskills.io/specification).

---

## Chat asset refs

The composer attaches library files as inline chips. Each chip is an `asset_ref` (`assetId`, library-relative `path`, `assetType`). The library highlight when the user sends is a separate `ui_selection` with the same fields. Click a chip or a `search_assets` / `inspect_asset` `asset_id` to select that file without leaving the Agent tab. See [AGENT](../AGENT.md) §5 and §6.3b.

- Drag from the library, right-click Add to chat, or + → Library file. External file and Finder drops copy into `Inbox/` first (reuse if already in the library). Composer attaches are chips, not `image_url`.
- Fold writes `<asset_ref>` where the chip sat. A leftover highlight is appended inside `<system-reminder>` as `<ui_selection>`. The bubble does not show that reminder. At send, look up the live path by `assetId`. Older rows stay frozen. Next-turn highlight skip looks only at the latest `ui_selection`.

---

## Library cut and drag

Files and folders move inside the library without minting a new `asset_id`. Cut (menu or Cmd/Ctrl+X) plus Paste, or drag onto another folder (or the tree background for the library root). Copy still duplicates. A folder cannot move into itself. Same-name collisions pick a unique name.

---

## Image input in the chat composer

The composer attaches JPEG, PNG, GIF, and WebP (up to 4, 8 MB each). A picture is an image part on the user message `content`, shown in the bubble, and sent as `image_url`. There is no vision switch and no retry. If the endpoint rejects the image, Loom shows the error and leaves that turn off the active path. The session file keeps the abandoned branch. Video and audio are not in this step. DeepSeek-V4.1-Flash accepts images and does not accept video.

---

## Branch from a previous question

Selecting a past question edits that message in place; sending switches the active path to just before it. The old path stays in the tree. Fork copies the prefix before that question into a new session, prefixes the title with `Fork: `, and leaves the original session unchanged. Files the agent already wrote stay as they are. See [AGENT](../AGENT.md) §6.3d.

---

## Follow-up while a run is active

Enter while a run is active queues the text as vendor `followUp`. The same run continues at the checkpoint where it would otherwise finish, inserting one queued follow-up at a time and waiting until that stretch ends before inserting the next. Queued messages share one region above the composer; once inserted, a message leaves the queue and appears in the thread as a user message. Stop still discards follow-ups that have not been inserted. `steer` and `nextRun` are unused. The queue is written into the Harness session, so a crash mid-run keeps it; a clean Stop does not.

---

## Automatic threshold compaction

Enabled the vendor's automatic threshold compaction (16,384 tokens reserved, ~20,000 tokens of recent context kept). Chat Settings gained an optional context-window field with a 128k fallback. Compaction events forward to AG-UI, and compaction summaries render in the transcript. Real-model verification lives in `packages/agent/evals/compaction-e2e.ts` (trigger, anchor retention, and post-compaction recall all pass).

---

## Production chat on Pi Harness

- Replaced the plain Pi `Agent` and Loom v1 transcript writer with one Harness session/runtime owner. New sessions live in each library's `.loom/harness-sessions/`; old `.loom/sessions/` files are neither read nor deleted.
- Preserved AG-UI chat, native workspace tools, library/FFmpeg/MCP tools, Stop, selection attachments, usage, and session controls. Unfinished operations resume automatically after model and MCP tools are ready.
- Kept automatic threshold compaction off pending model-window validation; overflow recovery remains active. Agent, app, core, and Electron session smoke tests cover the cutover.

---

## ✅ Vendor pi-agent and run one pure-Node agent loop

Vendored the source of pi's agent engine and completed one tool-calling run without Electron, UI, or a database.

- Created a pnpm workspace with `@loom/agent`; `vendor-pi-agent/` and `sync.sh` mirror pi `packages/agent` at `v0.85.1`
- Installed `@earendil-works/{pi-ai,chord,pi-telemetry}` plus `diff`, `ignore`, `typebox`, and `yaml`, aligned to 0.85.1
- Aligned `tsconfig.base.json` with pi compiler flags; vendor imports use the native Node `#vendor/pi-agent` imports mapping
- Added `src/{types.ts, pi-adapter.ts}` for Loom's stable interface and sole vendor boundary, plus `scripts/try-agent.ts`
- Ran `agent_start → tool_start → tool_end → text → agent_end`; vendor updates use the `vendor-clean` branch and `git merge`
- Verified DeepSeek model ID `deepseek-v4-flash` with provider `deepseek` and `DEEPSEEK_API_KEY`

---

## ✅ Electron shell and Agent conversation loop

Completed “UI input → Agent → model → streamed response” without introducing the database or asset library.

- Added `@loom/app` with Electron main, preload, and React renderer
- Main starts CopilotKit Runtime on a random `127.0.0.1` port and closes it on exit
- `LoomAgUiAgent` translates `LoomAgentEvent` into AG-UI events
- Typed IPC injects the runtime endpoint and agent ID into the renderer
- Renderer uses `CopilotKitProvider` and `CopilotChat` from `@copilotkit/react-core/v2`
- Ran `RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED`; typecheck, build, and startup passed

---

## ✅ Three-layer separation and asset-library skeleton

Completed “choose folder → scan → file tree → preview → live watcher updates” with an in-memory Store.

- Added `@loom/core`, separating Renderer, Main, and LocalCore; Renderer never accesses the filesystem or database directly
- Defined `MetadataStore` and `GraphStore` interfaces with in-memory implementations
- Implemented Library, LibraryPaths, and LibraryWatcher while ignoring `.loom/` and `.DS_Store`
- Added native folder selection, asset scanning, and UUID-based `asset_id`
- File tree shows hierarchy and thumbnails with folders collapsed by default
- Workbench previews images, video, audio, PDFs, and common text files
- Added the three-column Asset Library / Workbench / Agent-and-Details layout with draggable persisted widths
- Added native file actions: rename, duplicate, copy path, reveal in Finder, and move to Trash
- Split renderer code into file tree, preview, sidebar, side panel, and resizable-layout modules
- Tests cover scanning, watching, rename, duplication, and UUID preservation; typecheck and build pass

---

## ✅ SQLite MetadataStore

Replaced the in-memory asset index with persistent SQLite storage inside each library.

- Added `better-sqlite3`; the database is created at `<library>/.loom/metadata.db`
- Implemented `SqliteMetadataStore`: open, close, upsert, get, getByPath, list, and remove
- Added the `assets` table, unique relative paths, type and filesystem-identity indexes, and library metadata
- Switched the default LocalCore to SQLite while retaining `InMemoryMetadataStore` for focused tests and dependency injection
- Filesystem reconciliation reuses UUIDs, adds new files, and removes stale records
- Preserved watcher, preview, and context-menu behavior; explicit rename retains the original UUID
- Tests verify database creation, UUID persistence across LocalCore restarts, offline reconciliation, filesystem identity, volume relocation, and live edge cases

---

## ✅ Custom properties and Table view

Added typed, persistent user properties and a structured asset-table workspace.

- Added `text`, `number`, `boolean`, and calendar-date property definitions with runtime validation
- Added `properties` and `asset_properties` SQLite tables with foreign-key cleanup
- Extended MetadataStore and LocalCore with property-definition and asset-value CRUD
- Reworked full-library reconciliation to update retained asset rows in place, preserving property values through moves and path swaps
- Added custom-property creation, editing, clearing, and deletion to the Details panel
- Enabled the Table view with dynamic property columns, typed sorting, text filtering, and row selection
- Added tests for both in-memory and SQLite stores, persistence across reopen, cascading cleanup, non-destructive reconciliation, and typed table values

---

## ✅ Agent asset retrieval tools

Connected the live local asset library to the Agent through safe, structured tools.

- Added stable pi `toolCallId` propagation through Loom events and AG-UI, including repeated same-name calls
- Added `search_assets` for filename/path text, asset type, and AND-combined custom-property filters
- Added `inspect_asset` for one asset's metadata, custom properties, and renderer-safe preview reference
- Registered both tools in Electron Main through `@loom/agent`; absolute filesystem paths never enter model or UI results
- Preserved model text and structured `asset_list` / `asset_detail` channels through `TOOL_CALL_RESULT` and `CUSTOM loom.tool_result`
- Added retrieval, structured-result, invalid-argument, repeated-tool-call, and path-boundary tests

---

## ✅ Local asset enrichment

Added non-AI Level 1 technical metadata as a local cache keyed by `asset_id`.

- Added `asset_metadata` with fixed invalidation columns (`version`, `source_modified_at`, `status`, `error`) and a `kind` JSON payload
- Extractors read the file on disk: image size and safe EXIF, system `ffprobe` for audio/video, and size-capped text for txt/md/json/csv
- Auto-refresh missing or stale rows after open/reconcile; Analyze forces a rerun; rename/move does not
- Details shows read-only technical metadata plus Analyze
- Tests cover PNG dimensions, text extract, stale/mtime invalidation, persist, and rename skip

---

## ✅ FFmpeg Agent tools

Let the Agent call bundled FFmpeg for local media work; watcher indexes the outputs.

- Bundled `ffmpeg` / `ffprobe` via `pnpm vendor:ffmpeg` (npmmirror first); not committed, resolved from vendor then Electron `resources`
- Convenience tools: media info, frame extract, clip, resize, crop, convert; `run_ffmpeg` when those are not enough
- Tools accept library-relative paths only; absolute paths stay in Local Core
- Write outputs inside the library (default `outputs/`, or a caller-specified relative path)
- Enrichment ffprobe uses the same bundled binary; chat shows tool-call JSON results
- Tests cover path jail, real-fixture extract/resize/crop/convert, and skip without binaries

---

## ✅ Local Agent sessions

Persist multiple conversations per library as append-only JSONL, following pi's JsonlSessionRepo shape. Do not use CopilotKit cloud Threads.

- Session files under the current library `.loom/sessions/`; create, switch, and list
- Close archives a session (history stays, can reopen); delete is separate and refused while open
- Restore transcript into the Agent after restart so the model keeps context
- Agent panel uses session tabs; the first user message titles the tab
- Chat panel draws restored JSONL through CopilotChat.View (merged with the live run)
- Tests cover repo CRUD/archive, refusing delete while open, and keeping session files out of the asset watcher

---

## ✅ MCP client

Loom is an MCP client. Third-party servers attach beside first-party library tools.

- Main loads `mcp.json` or `LOOM_MCP_CONFIG` (stdio and Streamable HTTP); commands, URLs, and credentials stay out of the renderer
- Tools register as `server__tool` in the same Agent loop; a broken server is skipped
- Windows stdio resolves `npx` via `node.exe` + `npx-cli.js` (cannot spawn `.cmd` directly)
- First-party tools stay search, FFmpeg, and path jail; creation providers are not hardcoded
- Tests cover config parse, name prefix, error surfacing, host skip, and PATHEXT rewrite; live fetch smoke is optional

---

## ✅ Output provenance

Record where FFmpeg convenience-tool outputs came from. Edges go in Ladybug; the Graph view is not built yet.

- Ladybug at `.loom/graph.db`; `GENERATED_FROM` is output → source, keyed by asset UUID
- Convenience tools index the output immediately and write the edge; `run_ffmpeg` does not
- `inspect_asset` returns `generatedFrom` / `generated`; Details lists them and can jump to the other file
- Graph handlers MERGE / `DETACH DELETE` Asset nodes. Tests cover persist, cascade, inspect, and real-fixture extract/convert vs raw `run_ffmpeg`

---

## ✅ Search Level 1 text

`search_assets` substring match now includes ready `asset_metadata` extracts. No FTS or vectors yet.

- Text files contribute their extracted body; images contribute camera / capture time; video and audio contribute codecs
- Kind, dimensions, duration, and failed/skipped rows are not searchable
- Tests cover file-text and camera hits, and that a dimension string does not match

---

## ✅ SQLite FTS5

`search_assets` text queries use FTS5 instead of scanning every asset in memory. Property filters stay AND. No vectors.

- `assets_fts` indexes filename, path, property values, and ready Level 1 extracts
- Rows refresh on asset, property, and enrichment writes; open rebuilds if counts drift
- Query tokens are prefix-ANDed (`canon eos` → `"canon"* AND "eos"*`)

---

## ✅ Global Graph canvas

Full-library force-directed canvas in the Graph tab. Pan, zoom, click a node to select it. No Cypher bar.

- Every indexed asset is a node; Ladybug edges are drawn between them
- Type-colored circles; click opens Details
- Layout is Fruchterman–Reingold in the renderer

---

## ✅ Manual relationships

Users create and delete edges. Types are free-form labels; `GENERATED_FROM` stays reserved for FFmpeg.

- Drag one Graph node onto another, then name the type (datalist of types already used)
- Details: pick another asset and a type; delete from the list or a selected Graph edge
- Stored as Ladybug `RELATED` plus `type`; unique `(from, to, type)`
- `inspect_asset` includes `links` for every touching edge

---

## ✅ Graph interaction

Live force field on the SVG canvas. Positions stay in the session.

- `d3-force`: drag a node body to move it; neighbors react, then settle after release
- Hover the rim for `+`; drag from `+` to create an edge
- Rubber-band highlights and snaps when it hits another node

---

## ✅ Image VLM

On-demand image write-up via the VLM slot, then the existing text embedding path. Import does not run it.

- OpenAI-compatible `POST /v1/chat/completions` with `image_url` (data URI). Local and remote share `baseUrl`, optional key, and `model`. Loom does not load or run the model
- JPEG / PNG / WebP / BMP only. Caption / tags Markdown in `image_vlm`; mtime skip on rename/move; changing the VLM model invalidates the write-up
- Details Caption and `describe_image`; then `embed_asset` folds the Markdown into `text_chunks`. Empty Embedding slot still keeps the text. No sidecar `.md`

---

## ✅ Video VLM

On-demand file-level write-up via the same VLM slot, then the text embedding path. Import does not run it. Scene chunks wait.

- Prefer native `video_url` (data URI, up to 32 MB) on OpenAI-compatible `POST /v1/chat/completions`. If the endpoint rejects it or the file is larger, FFmpeg extracts 1–3 temp JPEGs as `image_url`. Loom does not load or run the model
- avi / m4v / mkv / mov / mp4 / webm. Caption / tags Markdown in `video_vlm`; mtime skip on rename/move; changing the VLM model invalidates the write-up
- Details Caption and `describe_video`; then `embed_asset` folds the Markdown into `text_chunks`. Frames are not library assets. No sidecar `.md`

---

## ✅ Hybrid Search

`search_assets` fuses FTS ranks with child-chunk vectors. Property filters stay AND. Do not embed the whole library.

- sqlite-vec (or JS cosine) over **child** chunks that already have embeddings; a child hit can expand to its parent
- RRF fuse with `assets_fts` (`k = 60`). Return **passage + `asset_id`**. Empty Embedding slot or a failed query embed is FTS-only
- Minimal eval: `packages/core/tests/hybrid-search.test.ts`. See [TEXT](../RAG/TEXT.md)

---

## ✅ Audio understanding

On-demand file-level write-up for standalone audio via the Audio slot, then the text embedding path. Import does not run it.

- OpenAI-compatible `POST /v1/chat/completions` with an audio part. Hosted Qwen-Omni uses `input_audio` + `modalities: ["text"]` + `stream: true`. The VLM slot stays vision-only. Loom does not load or run the model
- FFmpeg converts locally if the endpoint rejects the original; size cap like video. Markdown in `audio_writeup`; mtime skip; changing the Audio model invalidates the write-up
- Details and `describe_audio`; then `embed_asset`. See [MEDIA](../RAG/MEDIA.md)

---

## ✅ Rerank

Optional second pass after Hybrid Search. Empty slot skips it.

- Cohere/Jina/Qianfan `POST /v1/rerank` (or `/v2/rerank`) with `query` + `documents` (the fused passages). Bailian `qwen3-rerank` rewrites a DashScope Chat URL to `.../compatible-api/v1/reranks`
- Failure, one hit, or a missing slot keeps the RRF order. Probe POSTs a tiny rerank call (not `GET /v1/models`)
- TEI-native `texts` waits. See [TEXT](../RAG/TEXT.md) and [SETTINGS](../SETTINGS.md)

---

## ✅ Stop conversation

CopilotChat Stop aborts the pi run and in-flight tools. The turn stays in the transcript. It is not a Chat error.

- Stop calls `LoomAgent.abort()`. That aborts the Chat stream, bash, FFmpeg (`child.kill()`), VLM/Audio/embedding/rerank `fetch`, and MCP `callTool`
- The aborted turn is still appended to JSONL. A user Stop is written into that turn's text, so the next prompt can tell it from an error

---

## ✅ Thinking

Model reasoning shows in the chat. Signatures stay on the transcript.

- Pi `thinking_start` / `thinking_delta` / `thinking_end` become the same `LoomAgentEvent`s, then AG-UI `REASONING_*`. Deprecated `THINKING_*` events do not create a chat message
- Redacted thinking is dropped. `thinkingSignature` / `thoughtSignature` are not sent to the frontend
- Reloading a session shows the same non-redacted thinking. See [AGENT](../AGENT.md) §6.3a
