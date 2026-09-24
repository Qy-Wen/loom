**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design and [AGENT.md](./AGENT.md) for the Agent architecture.
> Only the next three steps are detailed; later work stays at summary level.

---

## Step 1: Hybrid Search

Upgrade deterministic asset search into one retrieval stack combining lexical, vector, and structured filters.

- [ ] SQLite FTS full-text search over filenames, paths, properties, and extracted text
- [ ] sqlite-vec vector search over selectively enriched assets
- [ ] Metadata Filter over built-in fields and custom properties
- [ ] Fuse retrieval behind `search_assets` / `hybrid_search`
- [ ] Establish a minimal retrieval evaluation set

## Step 2: FFmpeg Agent tools

Let the Agent perform deterministic local media operations and index their outputs.

- [ ] Add media inspection, frame extraction, clipping, resizing, cropping, and format conversion tools
- [ ] Validate all asset IDs and keep filesystem paths inside Local Core
- [ ] Stream tool progress and support cancellation
- [ ] Index generated files and attach provenance to source asset IDs
- [ ] Add fixture-based tool and failure-path tests

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

- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Creation:** connect directly to ComfyUI for image and video generation
- **Relationship graph:** implement relationship storage with LadybugDB, automatic provenance, and Graph view
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
