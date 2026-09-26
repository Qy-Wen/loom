**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them. Path jail and sandbox come later.

---

## Step 1: Hybrid Search

sqlite-vec over child embeddings that already exist (Markdown chunks, and text from images / video). Property filters stay AND. Fuse FTS ranks with vector ranks using **RRF** (`k = 60`). Return the hit plus `asset_id`. Do not embed the whole library. See [TEXT](./RAG/TEXT.md).

- [x] sqlite-vec over child chunks that already have embeddings
- [x] RRF-fuse with `assets_fts`; a child hit can expand to its parent
- [x] Keep a minimal retrieval eval set

## Step 2: Audio understanding

Standalone audio files only. Do not run on the whole library by default. Same pattern as VLM: one HTTP write-up (scene, music, ambient sound, and speech if any), then the Embedding slot. Dedicated Whisper ASR and CLAP vectors wait. See [MEDIA](./RAG/MEDIA.md).

- [x] Add an Audio settings slot (`baseUrl`, optional key, `model`). Wire is OpenAI-compatible `POST /v1/chat/completions` with an audio part. The VLM slot stays vision-only.
- [x] FFmpeg converts locally if the file is not a form the endpoint accepts; keep a size cap like video. Loom does not run the model
- [x] Persist Markdown by `asset_id`, then `embed_asset`. Skip when mtime is unchanged; changing the Audio model invalidates the write-up. Details / Agent can request it and see status

## Step 3: Rerank

Optional second pass after Hybrid Search. Empty slot skips it. See [TEXT](./RAG/TEXT.md).

- [x] Cohere/Jina `POST /v1/rerank` with `query` + `documents` (the fused passages). TEI `texts` waits
- [x] Failure keeps the RRF order. One hit does not call the endpoint
- [x] `search_assets` uses the slot when it is on

---

Completed steps are recorded in the [ARCHIVE](./archive/ARCHIVE.md).

---

## Later

- **In-process OCR (optional):** RapidOCR + ONNX on CPU, behind a switch, off by default. Not required. Prefer VLM. See [MEDIA](./RAG/MEDIA.md).
- **Dedicated ASR:** OpenAI-compatible `POST /v1/audio/transcriptions`. Prefer the Audio understanding slot. See [MEDIA](./RAG/MEDIA.md).
- **CLIP / image vectors:** embed the image without going through text; later if needed
- **Session history UI:** show the restored transcript in the chat panel after restart
- **FFmpeg progress and cancel:** abort long jobs and stream protocol-level progress
- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
