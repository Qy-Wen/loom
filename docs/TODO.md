**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design and [AGENT.md](./AGENT.md) for the Agent architecture.
> Only the next three steps are detailed; later work stays at summary level.

---

## Step 1: Custom properties and Table view

Let users maintain structured properties for assets and browse and filter them in a table.

- [ ] Create `properties` and `asset_properties` tables
- [ ] Extend MetadataStore with CRUD for property definitions and values
- [ ] Support viewing and editing asset properties in the Details panel
- [ ] Support sorting and filtering in the Table view

## Step 2: Hybrid Search

Build one asset-search entry point that combines full-text search, vectors, and structured-property filters.

- [ ] SQLite FTS full-text search
- [ ] sqlite-vec vector search
- [ ] Metadata Filter property filtering
- [ ] Combine them behind `search_assets` / `hybrid_search`
- [ ] Establish a minimal retrieval evaluation set

## Step 3: Local asset enrichment

Add non-AI local media metadata as the foundation for search and later semantic analysis.

- [ ] Track enrichment job state and version
- [ ] Extract image EXIF, dimensions, and basic metadata
- [ ] Run ffprobe for audio/video duration, dimensions, codecs, and related metadata
- [ ] Extract common text formats into FTS
- [ ] Recompute only invalidated enrichment results after file changes

---

Completed steps are recorded in the [archive](./archive/README.md).

---

## Later

- **AI enrichment:** optional, on-demand embeddings and VLM semantic analysis
- **Frontend protocol extensions:** add thinking and rich tool output (`STATE_DELTA` / `CUSTOM`) to AgUiAdapter; see AGENT.md
- **Tools:** FFmpeg media-processing toolset
- **Creation:** connect directly to ComfyUI for image and video generation
- **Relationship graph:** implement relationship storage with LadybugDB, automatic provenance, and Graph view
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
