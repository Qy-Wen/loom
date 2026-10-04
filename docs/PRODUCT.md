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

Loom imposes **no directory structure**. Assets may stay flat or follow any hierarchy the user chooses, as in Finder or Obsidian. Loom adds only a hidden `.loom/` directory at the library root for databases, caches, and configuration; it does not otherwise interfere with file organization.

```
CreativeAssets/          -- selected library root
├── product.jpg          -- flat or arbitrarily nested assets
├── video.mp4
├── Campaign-A/          -- user-owned hierarchy
│   └── ...
├── notes.md
│
└── .loom/               -- hidden Loom metadata
     ├── metadata.db      -- SQLite: metadata, vector, FTS
     ├── graph.db         -- LadybugDB
     ├── thumbnails/
     ├── cache/
     ├── sessions/        -- local Agent transcripts (JSONL)
     └── config.json
```

- The user owns asset names, locations, and nesting.
- **Portable workspace:** copying the whole library directory, including `.loom/`, to another computer and choosing `Open Asset Library` restores the workspace. If `.loom/` is lost or damaged, derived indexes can be rebuilt without affecting asset files. Chat, embedding, rerank, and VLM endpoints live in app Settings, not in `.loom/`; see [SETTINGS.md](./SETTINGS.md).

### 3.2 SQLite — Metadata Store and Hybrid Search

SQLite stores all asset metadata, not only vectors. The database is `<library>/.loom/metadata.db`: the asset index (`assets`), library key-value state (`library_meta`), Obsidian-style custom properties (`properties`, `asset_properties`), and Level 1 technical metadata (`asset_metadata`). Column definitions are in [SCHEMA.md](./RAG/data/SCHEMA.md).

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

```
(:Asset)-[:GENERATED_FROM]->(:Asset)
(:Asset)-[:REFERENCE_OF]->(:Asset)
(:Asset)-[:BELONGS_TO]->(:Project)
(:Asset)-[:USES_CHARACTER]->(:Character)
(:Asset)-[:SAME_SERIES]->(:Asset)
(:Asset)-[:PUBLISHED_TO]->(:Post)
```

Users can create relationships manually:

```
image_A
   │
   └── reference_of
            ↓
        video_B
```

Agent-created outputs automatically receive provenance:

```
product.png
     │ GENERATED_FROM
     ↓
image_gen_01.png
     │ GENERATED_FROM
     ↓
video_01.mp4
```

Over time this becomes a **Creative Asset Graph**.

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

- Opening a library first scans the complete filesystem and then reconciles it: match by `file_system_id`, then relative path; after a volume change, trust only relative paths. This prevents incremental deletion from losing UUIDs for moved files.
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

Level 1 is a local cache of file-derived technical metadata (dimensions, duration, camera, text extract). It is stored in `asset_metadata` and invalidated by source `mtime` plus an extractor version.

Level 2 starts as chunked **Markdown** embeddings. Rules: [TEXT](./RAG/TEXT.md). Image, video, and audio become text first, then the same chunks; see [MEDIA](./RAG/MEDIA.md). Levels: [RAG](./RAG/RAG.md).

---

## 6. Agent tools and creation layer

The Agent calls tools to access external capabilities. Loom owns the library: search, FFmpeg, and pi workspace tools (`read` / `edit` / `write` / `bash`). Chat permission is Basic, Standard (default), or Full; Full intercepts no tools. Creation runtimes (ComfyUI and later) attach as MCP servers; do not add a first-party client per provider. A process sandbox is deferred.

### 6.1 FFmpeg — first Agent tools

FFmpeg alone supports many useful Agent workflows without requiring a generation model.

The open library is the working directory. Relative paths resolve against it; absolute paths are allowed. If omitted, convenience tools default to `outputs/`. `asset_id` remains the internal identity (see Section 4).

**Toolset:**

```
get_media_info      extract_frame       extract_clip
resize_video        crop_video          convert_format
run_ffmpeg
```

`run_ffmpeg` is the escape hatch for argv the convenience tools cannot express. `concat_video`, `change_speed`, `extract_audio`, and `add_subtitle` can wait; use `run_ffmpeg` until they exist.

Example:

> Convert all landscape videos to 9:16 and keep the first 10 seconds.

```
search_assets(type=video, aspect_ratio=16:9)
        ↓
parallel [
    ffmpeg.crop(...)
    ffmpeg.trim(...)
]
```

This provides a strong tool-calling demonstration.

### 6.2 Creation via MCP

ComfyUI, and later GPT Image / Kling / Seedance, attach as MCP servers. The Agent calls `server__tool` names; Loom does not embed each provider's HTTP API.

```
Agent
 ↓
MCP host  (stdio or remote HTTP)
 ↓
ComfyUI / other creation servers
```

If a server writes outside the library, the Agent copies the file in with `bash` or `write`. The existing watcher indexes it.

> Deferred: do not add `generate_image` / `generate_video` wrappers that hide providers. MCP tool names stay visible.

---

## 7. Complete Agent-loop example

> Use the best-performing images from last year's AirPods project to create a 15-second vertical video.

```
1.  understand_intent
2.  query_graph        Project = AirPods
3.  hybrid_search      rating / semantic / metadata
4.  inspect_assets
5.  plan_workflow
6.  MCP creation tool  → ComfyUI (or other server)
6b. bash / write       → copy into the library if needed
7.  ffmpeg             → 9:16 → 15 sec
8.  save_file          outputs/airpods_short_v2.mp4
9.  index_asset
10. create_relationship
        new_video --GENERATED_FROM--> source_images
11. update_metadata
```

The Agent closes the loop from retrieval through creation, indexing, and provenance.

---

## 8. Electron UI

Visual direction: **Obsidian + Finder + Lightroom + Cursor**.

The layout uses a left asset library, central workbench, and right Agent/Details panel, with Files, Gallery, Table, and Graph work views.

See [UI.md](./UI.md) for layout, panel responsibilities, and view design.

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
- Local Core may later become a standalone local service:

```
localhost:xxxx
POST /assets/search
POST /agent/run
POST /graph/query
```

The UI then remains unchanged if Local Core moves from Node to Python, Go, Rust, or the cloud. It also makes Loom legible as a backend and Agent-systems project.

> **The Agent channel already runs as a localhost service:** Main hosts CopilotKit Runtime, and Renderer connects over AG-UI; see AGENT.md Section 6. CopilotKit is temporary UI infrastructure and can later be replaced by a custom workbench without changing the AG-UI backend boundary.

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

Future publishing extension:

```
             Local Creative Agent
                      │
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
    ComfyUI       Xiaohongshu      Douyin
       ↓              ↓              ↓
     Create         Publish        Publish
```

---

## 10. Technical areas to cover

Introduce these progressively when real scenarios require them:

- **Skills:** done — load Agent Skills (`SKILL.md`) from `<library>/.agents/skills/` into the creative Agent. Do not vendor pi's coding-agent shell. See [AGENT](./AGENT.md).
- **Multi-Agent:** divide collaboration and orchestration by genuine creative roles.
- **Sandboxing:** isolate high-risk tools and generation jobs.
- **LangGraph:** orchestrate complex and recoverable creative workflows.
- **Fine-tuning / LoRA:** introduce only when real results and evaluations justify it.
- **MCP settings UI:** done — Settings → MCP tab.
- **Evals:** done — Agent behavior, tool calls, and retrieval quality. See [EVALS](./AGENT/EVALS.md).
- **Chat asset refs:** done — attach library assets in the composer; click `asset_id` citations in the thread to select that asset. See [AGENT](./AGENT.md) §5.
- **Branch from a message:** done — continue or fork a session from any turn. See [AGENT](./AGENT.md) §6.3d.
- **Human in the loop:** done — confirm `write` / `edit` (and optionally `bash`) from the chat footer. See [AGENT](./AGENT.md) §6.3e.
- **Observability:** record run traces, tool calls, latency, and token usage.
