**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design and [AGENT.md](./AGENT.md) for the Agent architecture.
> Only the next three steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them. Path jail and sandbox come later.

---

## Step 1: Hybrid Search

Upgrade lexical search into one retrieval stack with vectors and structured filters.

- [ ] sqlite-vec over selectively enriched assets
- [ ] Fuse retrieval behind `search_assets` / `hybrid_search`
- [ ] Establish a minimal retrieval evaluation set

---

Completed steps are recorded in the [archive](./archive/README.md).

---

## Later

- **AI enrichment:** on-demand Level 2 embeddings and VLM captions/tags; never enrich the whole library by default
- **Session history UI:** show the restored transcript in the chat panel after restart
- **FFmpeg progress and cancel:** abort long jobs and stream protocol-level progress
- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
