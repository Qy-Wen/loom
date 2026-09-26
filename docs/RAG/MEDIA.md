**English** | [简体中文](./MEDIA.zh-CN.md)

# Multimodal RAG

> How image, video, and audio join the same retrieve path. Overview: [RAG.md](./RAG.md). Markdown chunks: [TEXT.md](./TEXT.md). Work items: [TODO.md](../TODO.md).
>
> Record conclusions here.

---

## Loop

Media becomes **text** first, then the text RAG path. Do not embed an image or video as one vector.

```
image / video / audio on disk
    → Markdown (VLM / later ASR)
    → same parent/child chunks + Embedding slot    (index)
    → Hybrid Search                                (retrieve)
    → Agent answers or acts                        (generate / tools)
```

Do not stuff the library into the prompt. Do not run this on the whole library by default. Do not write a sidecar `.md` into the library (that would be another asset).

`search_assets` stays the retrieve step: **passage + `asset_id`**. Video hits can carry a time range later.

---

## Images

The user or the Agent requests one image. Import does not run it.

- **VLM:** the existing VLM slot. Wire is OpenAI-compatible `POST {baseUrl}/v1/chat/completions`; the user message includes `image_url` (a data URI for a local file). Local servers and remote APIs are the same form; hosted APIs usually need a key, local servers often omit it. Loom does not load or run the model.
- **Output:** caption / tags; visible text in the image may go into that write-up. Fold into fixed Markdown, then hand it to the Embedding slot. If that slot is empty, the text still stays.
- **Do not embed the image itself.** CLIP / SigLIP image vectors wait.
- **OCR:** not in-process in the first version; the VLM reads the words. Local CPU OCR is optional — see the placeholder below. Skipping it does not block VLM.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the VLM model invalidates the write-up. Changing the embedding model invalidates the chunk vectors.

Shape:

```markdown
## Caption
...
## Tags
...
## Text
... only if optional OCR is on ...
```

---

## Optional: in-process OCR

Not required. Prefer VLM. Add this if poster / screenshot / scan text needs to be more stable, or if the VLM is offline.

```
Image
  ├─ required: HTTP VLM (GPU / remote) → caption / tags
  └─ optional: in-process RapidOCR + ONNX Runtime (CPU) → text / bbox / score
           ↓
        same Markdown → Embedding slot
```

- **Runtime:** `onnxruntime-node` plus RapidOCR det / cls / rec small ONNX. No Python. No separate OCR HTTP server. Models stay out of git; if built, download into app user data on first use.
- **Resources:** CPU only, so it does not contend with the VLM GPU. Ship only the current-platform runtime.
- **Product:** a switch. Off by default. Turning it on does not mean the whole library runs automatically.
- **Store:** if built, a table keyed by `asset_id` for lines (text / bbox / score), folded into Markdown `## Text`. Not a blob in `asset_metadata`.

---

## Video

First version: FFmpeg extracts **one frame**, same VLM path, one write-up for the whole file. Do not run on the whole library by default.

Scene chunks, per-shot captions, soundtrack ASR, and frame OCR wait. The longer-term unit is still segmented index, not one vector for the file:

```
video.mp4
│
├── file-level write-up (first version: one frame + VLM)
│
├── Scene 1    00:00-00:08   caption + embedding   (later)
├── Scene 2    00:08-00:21   caption + embedding   (later)
└── transcript chunks                              (later)
```

A user can ask “find the shot where the person gets out of the car.” The Agent locates `video.mp4  01:13 - 01:18`, then `search_video_segments()` → `extract_clip(73s, 78s)`. That tool chain is not in the first version.

---

## Audio

Standalone audio files. Transcribe first, then hand the text to the Embedding slot. Import does not run it.

- A later ASR settings slot. Wire is OpenAI-compatible `POST /v1/audio/transcriptions` with timestamped segments.
- FFmpeg extracts audio locally; long files are split before upload and segment times are shifted back. Loom does not run the recognizer.
- Video soundtracks later reuse this ASR. Do not build a second pipeline.
- CLAP-style acoustic vectors wait; they do not use the text Embedding slot.

---

## Provider

Loom is only an HTTP client. The VLM does not run in-process.

- **Wire:** OpenAI-compatible `POST {baseUrl}/v1/chat/completions`. The user message includes `image_url` (a data URI for a local file).
- **Local or remote:** the same fields (`baseUrl`, optional API key, `model`). Local is a server the user runs (LM Studio, Ollama, and similar). Remote is the OpenAI-compatible call plus an API key.
- Endpoints are user-configured. There is no built-in default vendor. See [SETTINGS.md](../SETTINGS.md).

---

## Retrieve

Image / video / audio vectors are **text-chunk** vectors. They share `text_chunks` and Hybrid Search with Markdown. Do not add a separate vector search for media.

sqlite-vec and fusion with FTS / property filters stay in [TEXT.md](./TEXT.md) and the Hybrid Search work item.
