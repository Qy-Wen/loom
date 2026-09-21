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
