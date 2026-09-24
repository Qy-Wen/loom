**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design and [AGENT.md](./AGENT.md) for the Agent architecture.
> Only the next three steps are detailed; later work stays at summary level.

---

## Step 1: FFmpeg Agent tools

Let the Agent call FFmpeg for local media work and index the outputs.

- [x] Convenience tools: media info, frame extract, clip, resize, crop, convert; `run_ffmpeg` when those are not enough
- [x] Tools accept library-relative paths only; absolute paths stay in Local Core
- [x] Write outputs inside the library (default `outputs/`, or a caller-specified relative path) and let the existing watcher index them

## Step 2: Hybrid Search

Upgrade deterministic asset search into one retrieval stack combining lexical, vector, and structured filters.

- [ ] SQLite FTS full-text search over filenames, paths, properties, and extracted text
- [ ] sqlite-vec vector search over selectively enriched assets
- [ ] Metadata Filter over built-in fields and custom properties
- [ ] Fuse retrieval behind `search_assets` / `hybrid_search`
- [ ] Establish a minimal retrieval evaluation set

## Step 3: AI enrichment

Add optional, on-demand embeddings and VLM analysis on top of local technical metadata.

- [ ] Persist Level 2 embeddings for selected assets and expose them to Hybrid Search
- [ ] Add an on-demand VLM pass for captions, tags, or scene descriptions
- [ ] Track enrichment jobs and cost-visible status in the UI
- [ ] Keep all AI work user-triggered; never enrich the whole library by default

---

Completed steps are recorded in the [archive](./archive/README.md).

---

## Later

- **FFmpeg progress and cancel:** abort long jobs and stream protocol-level progress
- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Creation:** connect directly to ComfyUI for image and video generation
- **Relationship graph:** implement relationship storage with LadybugDB, automatic provenance, and Graph view
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
