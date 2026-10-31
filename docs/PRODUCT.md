**English** | [简体中文](./PRODUCT.zh-CN.md)

# Loom — Local-first AI Creative Workspace

> A local-first, AI-powered workspace for creative assets.
> The filesystem owns asset content, SQLite and the graph database provide understanding and indexes, and the Agent retrieves, organizes, transforms, and creates.

---

## 1. One-line positioning

> **The filesystem is the source of truth, the database is the cognitive layer, and the Agent is the operational layer.**

Loom is an Electron desktop client designed to run locally, without cloud requirements for now. A user selects a folder as an asset library. Loom treats it as the working directory and provides live preview, structured properties, asset relationships, semantic retrieval, and an Agent that can call FFmpeg, ComfyUI, and other tools to complete the loop from retrieval through creation to publishing.

---

## 2. Core principles

1. **The filesystem is the source of truth**
   - The database never owns asset files. Database loss may require reindexing but must never lose the assets themselves.
   - This is Loom's most important design constraint.

2. **Local-first**
   - All capabilities run locally by default; user data stays on the device.
   - Cloud and paid capabilities, such as VLM analysis, are optional additions rather than prerequisites.

3. **Progressive Enrichment**
   - Not every file deserves AI analysis. Users choose which assets receive embeddings or semantic analysis.
   - Importing a library must not automatically create uncontrolled API costs.

---

## 3. Three data responsibilities

The three data layers remain strictly separated.

```
Local filesystem
    ↓
Asset Identity / Metadata
    ↓
┌────────────────┬─────────────────┐
│ SQLite         │ LadybugDB       │
│ search / props │ asset graph     │
│ / vectors      │                 │
└────────────────┴─────────────────┘
        ↓
      Agent
        ↓
FFmpeg / ComfyUI / Publisher / ...
```

### 3.1 Filesystem — asset source of truth

Loom imposes **no directory structure**. Assets may stay flat or follow any hierarchy the user chooses, as in Finder or Obsidian. Loom adds only a hidden `.loom/` directory at the library root for everything it owns (indexes, grading data, and Agent state); it does not otherwise interfere with file organization.

```
CreativeAssets/                   -- selected library root; Loom imposes no structure
├── product.jpg                   -- flat or arbitrarily nested assets
├── video.mp4
├── Campaign-A/                   -- user-owned hierarchy
│   └── ...
├── notes.md
├── Inbox/                        -- composer imports; an ordinary, indexed folder
├── outputs/                      -- default tool output; an ordinary, indexed folder
│
└── .loom/                        -- everything Loom owns; hidden, never indexed
    ├── metadata-db/
    │   └── metadata.db           -- SQLite: assets, properties, metadata, vectors, FTS (with -wal, -shm)
    ├── graph-db/
    │   └── graph.db/             -- LadybugDB EXPORT directory
    ├── grades/
    │   └── luts/*.cube           -- LUTs imported from outside the library (created on first import)
    └── agents/
        ├── sessions/loom.sqlite  -- durable session store (with -wal, -shm)
        ├── command-allows/command-allows.json   -- remembered commands
        ├── skills/               -- SKILL.md directories
        ├── memory/MEMORY.md
        ├── traces/telemetry.sqlite   -- run traces and metrics, kept 30 days
        └── tool-results/<conversationId>/<taskId>.txt
```

The library root has no second reserved folder: names like `.agents` belong to the user. These paths are decided in one place, `LibraryPaths` in `core`.

Everything Loom writes to the system temp directory lives under one root, never in the library, so a crash leaves nothing in the user's assets:

```
<os.tmpdir()>/loom/
├── grade/run-*/{preview,frames}/   -- ffmpeg stills for the grade panel; one run-* per media service
├── vlm-frames/run-*/               -- video frames sent to the VLM; removed after each asset
├── audio/run-*/                    -- compressed audio for transcription; removed after each asset
├── composer/run-*/                 -- staging for clipboard images bound for Inbox/; removed after import
├── sandbox/                        -- process-sandbox spec files and spawn helpers
└── e2e/<pid>/                      -- Electron userData while Playwright runs
```

Only `core/src/temp.ts` builds these paths, and none is hard-coded to `/tmp` (the process sandbox may write only the library and `os.tmpdir()`). At startup the app deletes anything older than 24 hours.

- The user owns asset names, locations, and nesting.
- **Portable workspace:** copying the whole library directory, including `.loom/`, to another computer and choosing `Open Asset Library` restores the workspace. `.loom/` is user data, not a cache. Tags, favorites, properties, relations, chat sessions, memory, and skills exist only there, with no backup or export, and each asset's id is stored there too. If `.loom/` is lost or damaged, search indexes and write-ups can be rebuilt, but the rest is gone; asset files are unaffected. Chat, embedding, rerank, and VLM endpoints live in app Settings, not in `.loom/`; see [SETTINGS.md](./SETTINGS.md).

### 3.2 SQLite — Metadata Store and Hybrid Search

SQLite stores all asset metadata, not only vectors. The database is `<library>/.loom/metadata-db/metadata.db`: the asset index (`assets`), library key-value state (`library_meta`), Obsidian-style custom properties (`properties`, `asset_properties`), and Level 1 technical metadata (`asset_metadata`). Column definitions are in [SCHEMA.md](./RAG/SCHEMA.md).

Users may define fields such as:

```
Status       = Published
Brand        = Apple
Project      = Fall Campaign
Photographer = xxx
Rating       = 4
Featured     = true
```

These structured values belong in SQLite rather than the graph database because they support ordinary structured queries:

```
Brand = "Apple"
AND Status = "Published"
AND Rating >= 4
```

Combined with:

- **FTS** for full-text search
- **Vector Search** for semantic retrieval
- **Metadata Filter** for structured properties

these form **Hybrid Search**. That retrieve step, plus the Agent answering or acting from the returned passages, is Loom's RAG loop. See [RAG](./RAG/RAG.md).

### 3.3 LadybugDB — asset relationship graph

The graph database stores relationships with real product meaning rather than existing merely to include a graph database.

Today there is one node kind and one edge kind:

```
(:Asset {asset_id})-[:RELATED {relation_id, type}]->(:Asset)
```

`type` is free text (such as `reference_of` or `derived from`), set by the user or the Agent: the user can drag a line in the UI, and the Agent uses `create_relation` / `remove_relation`. The most common use is recording where a derived file came from:

```
product.png
     │ derived from
     ↓
image_gen_01.png
     │ derived from
     ↓
video_01.mp4
```

Search does not follow relations. The graph is for recording and browsing provenance, and the Agent reads a file's neighbours with `inspect_asset` (see [RAG](./RAG/RAG.md)). Over time this becomes a **Creative Asset Graph**.

---

## 4. Asset Identity

**A file path is never the asset ID.** Renaming or moving a file must not disconnect its properties and relationships.

```
asset_id = stable UUID, independent of path
path     = mutable pointer to the current location
```

Metadata, properties, and graph relationships attach to `asset_id`; `path` only locates the current file.

### File Watcher

The watcher updates the database for:

- add
- remove
- rename
- modify

Cross-platform file identity uses Node `fs.stat` `(dev, ino)` as `file_system_id`. On macOS/Linux this represents device and inode; on Windows it maps to volume and a 64-bit file index. It is an OS-assigned identity signal, not Loom's UUID. `asset_id` remains the business identity.

- Opening a library first scans the complete filesystem and then reconciles it: match by `file_system_id`, then relative path; after a volume change, trust only relative paths. A path match does not need the same `file_system_id`: a file at a known path is that asset even with a new identity, as after an editor's save-by-rename or a restore from backup. The cost is that a different file put at a deleted file's path while Loom was closed inherits its tags and other data. A file that moved away is matched by identity first, so its old path does not keep the asset. This prevents incremental deletion from losing UUIDs for moved files.
- Identified additions, removals, moves, and updates flow through `LibraryHandlers`, which dispatches to metadata and graph handlers. Graph handlers MERGE or `DETACH DELETE` `Asset` nodes in Ladybug.
- While the app is open, watcher events are allowed to settle and then use the same full-library reconciliation. This avoids losing UUIDs when a whole folder is renamed or files exchange paths.
- If the filesystem does not expose a usable identity, as on some FAT or virtual filesystems, matching falls back to paths. Hash-based verification is deferred.
- On open, Loom compares the stored volume ID with the current root `stat.dev`. Copying the whole library to another volume causes path-based reconciliation and refreshes all filesystem identities.

---

## 5. Progressive Enrichment

Asset understanding deepens gradually under user control. **Not every file deserves AI analysis.** Users decide whether an asset receives embeddings or semantic analysis.

```
Level 0  Filesystem metadata         Free
   ↓
Level 1  FFprobe / EXIF / text       Local compute
   ↓
Level 2  Embedding                   Optional
   ↓
Level 3  VLM semantic understanding  Optional, may cost money
   ↓
Level 4  Deep analysis               Optional
```

Level 1 is a local cache of file-derived technical metadata (dimensions, duration, camera, text extract). It is stored in `asset_metadata` and runs when a library opens or a file changes. A ready row is invalidated by source `mtime` plus an extractor version; a failed row is retried on the next open or reconcile.

Level 2 starts as chunked **Markdown** embeddings. Rules: [RAG](./RAG/RAG.md#text-index). Image, video, and audio become text first, then the same chunks; see [RAG](./RAG/RAG.md#image-video-and-audio).

---

## 6. Agent tools and creation layer

The Agent calls tools to access external capabilities. Loom owns the library: search, FFmpeg, and pi workspace tools (`read` / `edit` / `write` / `bash`). Chat permission is Basic, Standard (default), or Full. Creation runtimes (such as ComfyUI) attach as MCP servers; do not add a first-party client per provider. Permission and the process sandbox: [PERMISSION](./agent/PERMISSION.md).

### 6.1 FFmpeg — first Agent tools

FFmpeg alone supports many useful Agent workflows without requiring a generation model.

The open library is the working directory. Relative paths resolve against it; absolute paths are allowed. The Agent writes results to `outputs/` unless the user names a path. `asset_id` remains the internal identity (see Section 4).

**Toolset:**

```
grade_image         run_ffmpeg          run_ffprobe
```

`run_ffmpeg` covers every media edit except still-image color grading, which `grade_image` handles; its description carries example argv for frame extraction, clips, resize, crop, and conversion. `run_ffprobe` returns ffprobe stdout, which is how the Agent reads duration, resolution, and codecs. Both take an argv array without the program name; the binaries are bundled and may not be on the shell PATH, so the Agent must not run them from `bash`.

Example:

> Convert all landscape videos to 9:16 and keep the first 10 seconds.

```
search_assets(type=video)          -- find the videos
        ↓
run_ffprobe(...)                   -- read the resolution, pick the landscape ones
        ↓
run_ffmpeg(...) × N                -- one call per video: crop to 9:16 and keep 10 s; independent calls in a turn run together
```

### 6.2 Creation via MCP

ComfyUI, GPT Image, Kling, Seedance, and other creation services attach as MCP servers. The Agent calls `server__tool` names; Loom does not embed each provider's HTTP API.

```
Agent
 ↓
MCP host  (stdio or remote HTTP)
 ↓
ComfyUI / other creation servers
```

If a server writes outside the library, the Agent copies the file in with `bash` or `write`. The existing watcher indexes it.

> Loom does not provide `generate_image` / `generate_video` wrappers that hide providers; MCP tool names stay visible.

---

## 7. Complete Agent-loop example

> Use the best-performing images from last year's AirPods project to create a 15-second vertical video.

An illustrative flow: the steps show the order of work, and tool names follow what is actually registered.

```
1.  deep_search_assets   property project=AirPods, rating >= 4, plus a semantic query
2.  inspect_asset        read the candidates' metadata, captions, and relations
3.  MCP creation tool    → ComfyUI (or other server)
3b. bash / write         → copy into the library if needed
4.  run_ffmpeg           → 9:16 → 15 sec
5.  file lands in outputs/   airpods_short_v2.mp4, indexed by the watcher
6.  create_relation
        new_video --"derived from"--> source_images
7.  set_asset_property   status = draft
```

The Agent closes the loop from retrieval through creation, indexing, and provenance.

---

## 8. Electron UI

Visual direction: **Obsidian + Finder + Lightroom + Cursor**.

The layout is a left asset library, a central workbench, and separate Chat and Details windows, with Files, Table, and Graph work views.

**Links.** The window stays on the app's own page. A web or mail link, whether it comes from a chat reply, a Markdown preview, or a script, opens in the system browser; a new window is never created. Any other link (`file:`, `javascript:`, a custom scheme) is refused, and so is a redirect off the app. This matters because the window exposes the `loom` bridge to its page, and a link that replaced the page would hand that bridge to a foreign site. If the page's process crashes, the window reloads it, up to three times a minute; past that it is left as it is and the log says so.

**Panels**
- Chat and Details start as two tabs in the right column, with Chat selected.
- Drag a title to move a panel. Near the lower middle it snaps into a band that meets the left and right sidebars. Drag it back to the right edge, or double-click the title, to dock it again.
- Drop onto the center of another window to merge tabs. In docked regions, drop onto a slot's top or bottom edge to stack above or below it; the blue preview shows the landing area, and each slot can have its own tab group.
- Drag a tab sideways in the tab bar to swap two tabs; drag a tab out to separate it. Drag a divider to resize stacked panels. Vertical order and sizes survive reload.
- On first use, image Edit opens Grade as a tab in the right sidebar; later opens restore its saved placement.

**File tabs (Files view)**
- The workbench shows open files as browser-style tabs. A plain click on a file shows it in the active tab; middle-click it, or choose "Open in new tab" in its menu, to open it in a new tab next to the active one.
- A file is open in at most one tab. Drag a tab sideways to reorder it, or drag a file from the tree onto the tab strip to open it.
- Closing a tab (the × or middle-click) shows its neighbour, and a file that is deleted or leaves the library closes its tab.
- Tabs are not saved across restarts and keep no view state: zoom, playback position, and unsaved Grade edits reset when you switch away. Details and the Agent follow the active tab.

**File tree, favorites, tags, and properties**
- The file tree can show a list or icons.
- Favorites are a per-library list of files, stored by `asset_id` in `.loom/metadata-db/metadata.db` and shown above the tree; the section starts collapsed. Right-click a file to add or remove it. Rename and move keep the star.
- Tags are shared labels on the same ids, added or removed in Details. Above the tree, each tag opens like a folder to list the files that have it.
- Custom properties are columns in the table. The user and the Agent can add a field, set or clear a cell, and rename or delete a column. Details shows those filled values read-only in the File block; a field with no value on the selected file stays hidden.

Panel layout conventions:

- A new panel is registered only in `App.tsx` (`PanelRegistration`: stable `id`, title, visibility, renderer, optional initial position and first-open policy). Never branch on a panel ID in the layout hook, drag geometry, tabs, or CSS. A saved position beats the default; a hidden panel that was never opened takes no slot; unregistering removes stale IDs.
- Each slot stores ordered tabs, the active tab, position, and a size weight. Weights are normalized over the visible slots, so the region still fills after other slots are dragged out or hidden. A floating slot stores a rectangle relative to the shell.
- The layout is stored in `localStorage` under `loom.layout.panels` (versioned). Column widths and the central region's height are separate settings.
- The panel registration and floating e2e specs (`registered-panels`, `registered-float`) run only in a `build:e2e` build made with `LOOM_E2E_PANELS=1`; a normal production build has no fixture entry.

## 9. Architecture

### Process separation: Renderer / Main / Local Core

```
Electron Renderer
       ↓ IPC
Electron Main
       ↓
Local Core
```

- Renderer **never** accesses the database directly.

- The Agent channel is a localhost service: Main hosts CopilotKit Runtime, and Renderer connects over AG-UI; see [AGENT](./agent/AGENT.md) §6. The chat UI uses CopilotKit's chat components.

### Capability layers

```
                Agent
                  │
          ┌───────┴───────┐
          │               │
      Retrieval        Creation
          │               │
   SQLite + Vector    FFmpeg / ComfyUI
          │
       Asset Graph
          │
      LadybugDB
          │
      Filesystem
```

---

## 10. Technical areas in place

- **Skills:** load Agent Skills (`SKILL.md`) from `<library>/.loom/agents/skills/` into the creative Agent. Do not vendor pi's coding-agent shell. See [AGENT](./agent/AGENT.md).
- **Multi-Agent:** chat Agent plus retrieve and create specialists. Independent calls in one turn run together. See [AGENT](./agent/AGENT.md).
- **Sandboxing:** bash and FFmpeg run inside it. Generation stays MCP and is not wrapped in this sandbox. See [PERMISSION](./agent/PERMISSION.md).
- **MCP settings UI:** Settings → MCP tab.
- **Evals:** Agent behavior, tool calls, and retrieval quality. See [EVALS](./agent/EVALS.md).
- **Chat asset refs:** attach library assets in the composer; an `<asset_ref>` block in a reply selects that file by `asset_id`, then by path. See [AGENT](./agent/AGENT.md) §5.
- **Branch from a message:** continue or fork a session from any turn. See [AGENT](./agent/AGENT.md) §3.
- **Human in the loop:** Standard confirms `write` / `edit` outside the open library; Basic also confirms `bash` and the FFmpeg tools that write. See [PERMISSION](./agent/PERMISSION.md).
- **Observability:** record run traces, tool calls, latency, and token usage in `.loom/agents/traces/telemetry.sqlite`. See [TRACE](./agent/TRACE.md).
