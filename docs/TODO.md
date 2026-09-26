**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next three steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them. Path jail and sandbox come later.

---

## Step 1: Image VLM

Turn the image into text, then use the existing text embedding path. Do not embed the image as a vector. Do not embed the whole library by default. Uses the VLM slot: chat completions with `image_url`. See [MEDIA](./RAG/MEDIA.md).

- [ ] HTTP caption / tags (may include visible text in the image). Loom does not load or run the model
- [ ] Persist the text per asset; skip rename/move when mtime is unchanged
- [ ] Fold into Markdown and hand it to the Embedding slot. If that slot is empty, the text still stays. Details / Agent can request it and see status

## Step 2: Video VLM

Extract one frame and use the same VLM path. Do not embed the whole library by default. Scenes and dialogue wait.

- [ ] FFmpeg extracts one frame, then send it to the VLM; persist the text per asset
- [ ] Fold into Markdown and hand it to the Embedding slot. Skip when mtime is unchanged; Details / Agent can request it and see status

## Step 3: Audio transcription

Audio files only. Do not transcribe the whole library by default. Transcribe first, then hand the text to the Embedding slot. Acoustic vectors wait.

- [ ] Add an ASR settings slot (`baseUrl`, optional key, `model`). Wire is OpenAI-compatible `POST /v1/audio/transcriptions` with timestamped segments
- [ ] FFmpeg extracts audio locally; long files are split before upload and segment times are shifted back. Loom does not run the model
- [ ] Persist segments by `asset_id`, then embed them with the Embedding slot. Skip when mtime is unchanged; changing the ASR model invalidates the transcript. Details / Agent can request it and see status

---

Completed steps are recorded in the [ARCHIVE](./archive/ARCHIVE.md).

---

## Later

- **Hybrid Search:** sqlite-vec over embeddings that already exist (text chunks, and text from images / video); fuse with FTS and property filters; return the hit plus `asset_id`; keep a minimal retrieval eval set
- **In-process OCR (optional):** RapidOCR + ONNX on CPU, behind a switch, off by default. Not required. Prefer VLM. See [MEDIA](./RAG/MEDIA.md).
- **CLIP / image vectors:** embed the image without going through text; later if needed
- **Session history UI:** show the restored transcript in the chat panel after restart
- **FFmpeg progress and cancel:** abort long jobs and stream protocol-level progress
- **Frontend protocol extensions:** add thinking and interactive rendering for structured tool results; see AGENT.md
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
