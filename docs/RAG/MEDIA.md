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
    → Markdown (VLM / Audio understanding)
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

On-demand file-level write-up, same VLM slot as images. Do not run on the whole library by default.

**How to send the video**

1. **Native video** when the endpoint accepts it: OpenAI-compatible `POST /v1/chat/completions` with a `video_url` data URI (files up to 32 MB). Models such as Qwen3-VL can do this. Loom stays an HTTP client; it does not decode video in-process except as needed to attach the request. A 400/413/415/422/5xx from native is remembered per endpoint+model for the process, then frames are used.
2. **Frames as `image_url`** when native is skipped or rejected: FFmpeg extracts 1–3 temp JPEGs (about 10% / 50% / 90% of duration; fewer for short clips). They are not library assets.

One Markdown write-up per file in this step. Scene chunks, per-shot captions, soundtrack understanding, and frame OCR wait. The longer-term unit is still segmented index, not one vector for the file:

```
video.mp4
│
├── file-level write-up (this step: native video, or frames if the endpoint cannot)
│
├── Scene 1    00:00-00:08   caption + embedding   (later)
├── Scene 2    00:08-00:21   caption + embedding   (later)
└── transcript chunks                              (later)
```

A user can ask “find the shot where the person gets out of the car.” The Agent locates `video.mp4  01:13 - 01:18`, then `search_video_segments()` → `extract_clip(73s, 78s)`. That tool chain is not in this step.

---

## Audio

Standalone audio files. On-demand file-level write-up, same idea as image VLM: one model that can describe music and ambient sound, and transcribe speech when there is any. Import does not run it. Do not reuse the VLM slot (that slot is vision-only).

- **Audio slot:** OpenAI-compatible `POST {baseUrl}/v1/chat/completions`; the user message includes an audio part. Local and remote are the same fields. There is no built-in default vendor. Loom does not load or run the model. LM Studio cannot take audio on `/v1/chat/completions`. Qianfan compatible chat has no audio part. Hosted Qwen-Omni is DashScope compatible-mode (`input_audio.data` as `data:;base64,...` + `modalities: ["text"]` + `stream: true`). Local OpenAI-compatible audio servers still try `audio_url` then `input_audio`.
- **Output:** caption / tags; speech goes under Transcript when present. Fold into fixed Markdown, then hand it to the Embedding slot. If that slot is empty, the text still stays.
- **Do not embed the waveform.** CLAP-style acoustic vectors wait; they do not use the text Embedding slot.
- **ASR:** not a separate `/v1/audio/transcriptions` path in this step. Prefer the Audio understanding model, as image OCR prefers VLM. Dedicated Whisper waits.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the Audio model invalidates the write-up. Changing the embedding model invalidates the chunk vectors.
- FFmpeg converts locally when the file is not a form the endpoint accepts. Keep a size cap like video (data URI, up to 32 MB). Over that cap, compact to 16 kHz mono MP3. DashScope-looking URLs send Omni first (`input_audio`, stream, text-only modalities). Other URLs try `audio_url`, then `input_audio`, then Omni. DashScope’s encoded-audio cap is 10 MB. Video soundtracks later reuse this slot. Do not build a second pipeline.
- **Store:** `audio_writeup` keyed by `asset_id`. Details Caption and `describe_audio`; then `embed_asset` folds the Markdown into `text_chunks`. Empty Embedding slot still keeps the text. No sidecar `.md`.

Shape:

```markdown
## Caption
...
## Tags
...
## Transcript
... only if there is speech ...
```

---

## Provider

Loom is only an HTTP client. The VLM and Audio models do not run in-process.

- **Wire:** OpenAI-compatible `POST {baseUrl}/v1/chat/completions`. Images use `image_url` (a data URI for a local file). Video tries `video_url` (data URI, up to 32 MB) when the endpoint allows it; otherwise extracted frames as `image_url`. Audio uses the Audio slot: hosted Omni is streamed `input_audio`; other endpoints try `audio_url` / `input_audio`. Not the VLM slot.
- **Local or remote:** the same fields (`baseUrl`, optional API key, `model`). Local is a server the user runs. Remote audio that works today is DashScope compatible-mode Qwen-Omni, not Qianfan. See [SETTINGS.md](../SETTINGS.md).
- Endpoints are user-configured. There is no built-in default vendor. See [SETTINGS.md](../SETTINGS.md).

---

## Retrieve

Image / video / audio vectors are **text-chunk** vectors. They share `text_chunks` and Hybrid Search with Markdown. Do not add a separate vector search for media.

sqlite-vec and RRF fusion with FTS / property filters stay in [TEXT.md](./TEXT.md).
