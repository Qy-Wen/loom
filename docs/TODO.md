**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design and [AGENT.md](./AGENT.md) for the Agent architecture.
> Only the next three steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, path jail, and ingest.

---

## Step 1: Library ingest for MCP outputs

MCP servers create files wherever they want. Loom only indexes the library, so the Agent needs one first-party way to land bytes or a file inside the current library.

- [ ] First-party tool writes into the library by relative path (default `outputs/`); absolute paths stay in Main
- [ ] Accept MCP-returned bytes or a path the host can read; copy into the library, then let the watcher index
- [ ] Not Comfy-specific; the same tool serves any creation MCP
- [ ] Do not add `generate_image` / `generate_video` or a Comfy HTTP client

## Step 2: Output provenance

Record where Agent-created files came from. Do not introduce LadybugDB or the Graph view yet.

- [ ] Persist `GENERATED_FROM` (or equivalent) when FFmpeg convenience tools write an output
- [ ] Persist the same edge when ingest writes an MCP output
- [ ] Expose those edges on `inspect_asset` and in Details
- [ ] Keep the store thin (SQLite is enough); graph handlers can stay no-op

## Step 3: Search Level 1 text

- [ ] Include `asset_metadata` extracts in the current `search_assets` match
- [ ] Do not add FTS, vectors, or Hybrid Search yet

---

Completed steps are recorded in the [archive](./archive/README.md).

---

## Later

- **Hybrid Search:** SQLite FTS, sqlite-vec, fused `hybrid_search`, and a minimal retrieval eval set — after embeddings exist
- **AI enrichment:** on-demand Level 2 embeddings and VLM captions/tags; never enrich the whole library by default
- **Relationship graph:** LadybugDB, Graph view, and manual relationship editing
- **Session history UI:** show the restored transcript in the chat panel after restart
- **FFmpeg progress and cancel:** abort long jobs and stream protocol-level progress
- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
