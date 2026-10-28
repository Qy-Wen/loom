**English** | [简体中文](./RAG.zh-CN.md)

# RAG

> How Loom turns library files into grounded Agent answers. Product framing stays in [PRODUCT.md](../PRODUCT.md) §3.2 / §5. Work items stay in [TODO.md](../TODO.md).
>
> Text (first path): [TEXT.md](./TEXT.md). Image / video / audio: [MEDIA.md](./MEDIA.md). Schema: [SCHEMA.md](./SCHEMA.md).

---

## Loop

```
file on disk
    → Level 1 extract
    → chunks + embeddings          (index)
    → deep search                  (retrieve)
    → Agent answers or acts        (generate / tools)
```

That is RAG. Do not stuff the library into the prompt. Do not embed the whole library by default.

First path is chunked Markdown. Rules: [TEXT.md](./TEXT.md). Image, video, and audio become text first, then the same chunks; see [MEDIA.md](./MEDIA.md).

Retrieval is two tools, split by what they read:

- `search_assets` is **simple search**: file-level full text over filename, path, properties, extracts, and write-ups, plus type and property filters. It uses no model, needs no index, and sees every file. It returns whole files.
- `deep_search_assets` is **deep search**, the retrieve step of the loop above: chunk full text and chunk vectors fused with RRF, an optional Rerank slot, one best **passage + `asset_id`** per file. It only sees indexed files and reports `indexedCount`.

Neither follows relations; to see a file's source or derived files the Agent calls `inspect_asset`. See [TEXT.md](./TEXT.md) and [SEARCH.md](./SEARCH.md).

---

## Library job lifecycle

Each library opening owns a task scope. Switching or closing stops admission and the watcher, cancels jobs, drains storage writes and media cleanup, then closes storage. Queued jobs do not start after cancellation; late provider output cannot publish into another opening. Opening recovers interrupted description/embedding records as retryable failures. Detail reads and action results are checked against the current opening, selection, and request.

Image, video, and audio descriptions compose the shared `rag/description.ts` workflow and `model/description.ts` record/status types. Each media service retains its own serial queue and input preparation; the shared workflow handles cache freshness, transitions, failures, and notifications. LocalCore continues to bind jobs and notifications to the current library task scope.

---

## Enrichment levels

Asset understanding deepens incrementally. Users control both scope and cost. **Not every file deserves AI analysis.** Users explicitly choose which assets receive embeddings or semantic analysis, avoiding uncontrolled API spending at import time.

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

| Level | Content | Cost | Trigger |
|---|---|---|---|
| 0 | Filesystem metadata: path, size, hash, mtime, type | Free | Automatic on import |
| 1 | FFprobe (duration/resolution/codec), EXIF, text extraction | Local compute | Automatic |
| 2 | Chunked Markdown embeddings; image / video / audio become text first, then chunk; see [MEDIA](./MEDIA.md) | Optional, HTTP provider (local server or remote API key) | User-selected |
| 3 | VLM writes captions / tags for images, and file-level video (native video or frames); Audio slot writes file-level audio | May cost money | User-selected |
| 4 | Deep analysis: segmentation, quality scoring, style tags, and more | May cost money | User-selected |

- Level 1 writes `asset_metadata` keyed by `asset_id`. Common invalidation columns stay fixed; per-type fields are a `kind` JSON payload (`image` / `video` / `audio` / `text`).
- Level 1 is extracted from the file on disk. Missing, failed, or stale rows refresh after open and reconcile. Rename/move of a ready row does not.
- Level 2/3/4 outputs stay in SQLite (vectors, FTS, and metadata); see PRODUCT.md Section 3.2.

---

## Media

Image / video / audio conclusions: [MEDIA.md](./MEDIA.md). Images are a VLM write-up then text embeddings. Video is the same, preferring native video when the endpoint allows it, otherwise frames. Audio is an Audio-slot write-up, then the same text embeddings. Scene chunks wait.
