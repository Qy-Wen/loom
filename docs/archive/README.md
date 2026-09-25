**English** | [简体中文](./README.zh-CN.md)

# Archive

Completed milestones are recorded here. See the current [TODO](../TODO.md).

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
