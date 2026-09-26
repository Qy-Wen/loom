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

## Step 2: Audio transcription

Audio files only. Do not transcribe the whole library by default. Transcribe first, then hand the text to the Embedding slot. Acoustic vectors wait.

- [ ] Add an ASR settings slot (`baseUrl`, optional key, `model`). Wire is OpenAI-compatible `POST /v1/audio/transcriptions` with timestamped segments
- [ ] FFmpeg extracts audio locally; long files are split before upload and segment times are shifted back. Loom does not run the model
- [ ] Persist segments by `asset_id`, then embed them with the Embedding slot. Skip when mtime is unchanged; changing the ASR model invalidates the transcript. Details / Agent can request it and see status

---

Completed steps are recorded in the [ARCHIVE](./archive/ARCHIVE.md).

---

## Later

- **In-process OCR (optional):** RapidOCR + ONNX on CPU, behind a switch, off by default. Not required. Prefer VLM. See [MEDIA](./RAG/MEDIA.md).
- **CLIP / image vectors:** embed the image without going through text; later if needed
- **Session history UI:** show the restored transcript in the chat panel after restart
- **FFmpeg progress and cancel:** abort long jobs and stream protocol-level progress
- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
