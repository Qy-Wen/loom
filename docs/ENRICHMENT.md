**English** | [简体中文](./ENRICHMENT.zh-CN.md)

# Asset Enrichment and Media Understanding

> This document expands Section 5, “Progressive Enrichment,” of [PRODUCT.md](./PRODUCT.md). It records the enrichment levels, media-specific pipelines, and multi-granularity video-understanding design.
>
> PRODUCT.md retains the high-level framework; processing details live here.

---

## 1. Progressive Enrichment levels

Asset understanding deepens incrementally. Users control both scope and cost.

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
| 2 | Chunked text embeddings first (RAG index); image/video later | Optional, local or cloud | User-selected |
| 3 | VLM semantics: caption, scene, people, OCR, ASR | May cost money | User-selected |
| 4 | Deep analysis: segmentation, quality scoring, style tags, and more | May cost money | User-selected |

Design principle: **not every file deserves AI analysis**. Users explicitly choose which assets receive embeddings or semantic analysis, avoiding uncontrolled API spending at import time.

---

## 2. Example: enriching a video

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

Result:

```
Content:    A woman taking photos with a phone by the sea
People:     Woman
Scene:      Seaside / sunset
Product:    Phone
Style:      Warm / lifestyle
Transcript: ...
Embedding:  [...]
```

---

## 3. Multi-granularity video understanding

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

This lets a user ask:

> Find the shot where the person gets out of the car.

The Agent can locate the exact segment:

```
video.mp4  01:13 - 01:18
```

Then run:

```
search_video_segments()
        ↓
extract_clip(73s, 78s)
```

Asset search becomes true media understanding and manipulation rather than file-level lookup.

---

## 4. Relationship to retrieval (RAG)

Level 1 extract → Level 2 chunks + vectors → Hybrid Search → Agent uses the passages. That is RAG. Do not embed the whole library by default.

- Level 1 writes `asset_metadata` keyed by `asset_id`. Common invalidation columns stay fixed; per-type fields are a `kind` JSON payload (`image` / `video` / `audio` / `text`).
- Level 1 is extracted from the file on disk. Missing or stale rows refresh after reconcile; Analyze forces a rerun. Rename/move does not.
- Level 2 starts with text chunks (short files stay one chunk). Each chunk stores text, offsets, vector, and model id. Analyze stays Level 1; embed is a separate user/Agent action.
- Hybrid Search retrieves those chunks and returns passage + `asset_id` so the Agent can cite or open the file. sqlite-vec and fusion come after the index exists.
- Image and video embeddings, then scene / transcript chunks, reuse the same retrieve path.
- Level 2/3/4 outputs stay in SQLite (vectors, FTS, and metadata); see PRODUCT.md Section 3.2.
