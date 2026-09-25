**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design and [AGENT.md](./AGENT.md) for the Agent architecture.
> Only the next three steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them. Path jail and sandbox come later.

---

## Step 1: Text embeddings (RAG index)

Index is chunked text, not one vector per file. Text assets only. Do not embed the whole library by default. Images and video wait.

- [ ] Chunk Level 1 text extracts (short files stay one chunk; overlap on long files)
- [ ] `EmbeddingProvider` seam; persist chunks + vectors + model id; skip rename/move when mtime is unchanged
- [ ] Details / Agent can request embed and see status

## Step 2: Hybrid Search (RAG retrieve)

Retrieve chunks, then ground the Agent on those passages. Fuse with the existing FTS and property filters.

- [ ] sqlite-vec over text chunks that already have embeddings
- [ ] Fuse behind `search_assets` / `hybrid_search`; return passage + `asset_id`
- [ ] Establish a minimal retrieval evaluation set

---

Completed steps are recorded in the [archive](./archive/README.md).

---

## Later

- **Image / video embeddings:** CLIP-style or one keyframe; same RAG retrieve path
- **Level 3 VLM:** on-demand captions/tags; never enrich the whole library by default
- **Session history UI:** show the restored transcript in the chat panel after restart
- **FFmpeg progress and cancel:** abort long jobs and stream protocol-level progress
- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
