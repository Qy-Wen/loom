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
    → Hybrid Search                (retrieve)
    → Agent answers or acts        (generate / tools)
```

That is RAG. Do not stuff the library into the prompt. Do not embed the whole library by default.

First path is chunked Markdown. Rules: [TEXT.md](./TEXT.md). Image, video, and audio become text first, then the same chunks; see [MEDIA.md](./MEDIA.md).

`search_assets` is the retrieve step. It is FTS today. After the index exists it returns **passage + `asset_id`**, fused with FTS and property filters.

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
| 1 | FFprobe (duration/resolution/codec), EXIF, text extraction | Local compute | Automatic or on demand |
| 2 | Chunked Markdown embeddings; image / video / audio become text first, then chunk; see [MEDIA](./MEDIA.md) | Optional, HTTP provider (local server or remote API key) | User-selected |
| 3 | VLM writes captions / tags for images, and file-level video (native video or frames); dedicated OCR / ASR wait | May cost money | User-selected |
| 4 | Deep analysis: segmentation, quality scoring, style tags, and more | May cost money | User-selected |

- Level 1 writes `asset_metadata` keyed by `asset_id`. Common invalidation columns stay fixed; per-type fields are a `kind` JSON payload (`image` / `video` / `audio` / `text`).
- Level 1 is extracted from the file on disk. Missing or stale rows refresh after reconcile; Analyze forces a rerun. Rename/move does not.
- Level 2/3/4 outputs stay in SQLite (vectors, FTS, and metadata); see PRODUCT.md Section 3.2.

---

## Media

Image / video / audio conclusions: [MEDIA.md](./MEDIA.md). Images are a VLM write-up then text embeddings. Video is the same, preferring native video when the endpoint allows it, otherwise frames. In-process OCR + ONNX is optional and off by default. Scene chunks and CLIP vectors wait.
