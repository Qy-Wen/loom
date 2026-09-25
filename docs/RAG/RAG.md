**English** | [简体中文](./RAG.zh-CN.md)

# RAG

> How Loom turns library files into grounded Agent answers. Product framing stays in [PRODUCT.md](../PRODUCT.md) §3.2 / §5. Work items stay in [TODO.md](../TODO.md).
>
> Text (first path): [TEXT.md](./TEXT.md). Schema: [SCHEMA.md](./data/SCHEMA.md).

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

First path is chunked Markdown. Rules: [TEXT.md](./TEXT.md). Image and video reuse the same retrieve step later.

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
| 2 | Chunked Markdown embeddings first (text RAG); image/video later | Optional, HTTP provider (local server or remote API key) | User-selected |
| 3 | VLM semantics: caption, scene, people, OCR, ASR | May cost money | User-selected |
| 4 | Deep analysis: segmentation, quality scoring, style tags, and more | May cost money | User-selected |

- Level 1 writes `asset_metadata` keyed by `asset_id`. Common invalidation columns stay fixed; per-type fields are a `kind` JSON payload (`image` / `video` / `audio` / `text`).
- Level 1 is extracted from the file on disk. Missing or stale rows refresh after reconcile; Analyze forces a rerun. Rename/move does not.
- Level 2/3/4 outputs stay in SQLite (vectors, FTS, and metadata); see PRODUCT.md Section 3.2.

---

## Video (later)

Immediately after import (Level 0 / 1):

```
video.mp4
duration:   120s
resolution: 4K
codec:      H264
```

After the user selects “AI Analyze” (Level 2 / 3):

```
FFmpeg
 ↓ keyframe extraction
VLM caption
 ↓
ASR transcript
 ↓
OCR
 ↓
Embedding
```

A video should not receive only one embedding. Scenes and transcript chunks should be indexed independently.

```
video.mp4
│
├── Asset embedding
│
├── Scene 1
│    ├── 00:00-00:08
│    ├── caption
│    └── embedding
│
├── Scene 2
│    ├── 00:08-00:21
│    ├── caption
│    └── embedding
│
└── transcript chunks
```

This lets a user ask “find the shot where the person gets out of the car.” The Agent locates `video.mp4  01:13 - 01:18`, then `search_video_segments()` → `extract_clip(73s, 78s)`.
