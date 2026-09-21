**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design and [AGENT.md](./AGENT.md) for the Agent architecture.
> Only the next three steps are detailed; later work stays at summary level.

---

## Step 1: Hybrid Search

Build one asset-search entry point that combines full-text search, vectors, and structured-property filters.

- [ ] SQLite FTS full-text search
- [ ] sqlite-vec vector search
- [ ] Metadata Filter property filtering
- [ ] Combine them behind `search_assets` / `hybrid_search`
- [ ] Establish a minimal retrieval evaluation set

## Step 2: Local asset enrichment

Add non-AI local media metadata as the foundation for search and later semantic analysis.

- [ ] Track enrichment job state and version
- [ ] Extract image EXIF, dimensions, and basic metadata
- [ ] Run ffprobe for audio/video duration, dimensions, codecs, and related metadata
- [ ] Extract common text formats into FTS
- [ ] Recompute only invalidated enrichment results after file changes

## Step 3: Agent asset tools

Connect the asset library to the Agent so it can retrieve and inspect real local assets.

- [ ] Add `search_assets` with structured filters and stable asset IDs
- [ ] Add `inspect_asset` for metadata, properties, and preview references
- [ ] Register the tools through `@loom/agent` without exposing filesystem paths
- [ ] Map tool results to AG-UI rich output for the workbench
- [ ] Add tool-call and permission regression tests

---

Completed steps are recorded in the [archive](./archive/README.md).

---

## Later

- **AI enrichment:** optional, on-demand embeddings and VLM semantic analysis
- **Frontend protocol extensions:** add thinking and other rich tool progress events to AgUiAdapter; see AGENT.md
- **Tools:** FFmpeg media-processing toolset
- **Creation:** connect directly to ComfyUI for image and video generation
- **Relationship graph:** implement relationship storage with LadybugDB, automatic provenance, and Graph view
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
