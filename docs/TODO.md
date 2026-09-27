**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them. Path jail and sandbox come later.

---

The retrieve path is done (Hybrid Search, Audio write-ups, optional Rerank). Completed steps are in the [ARCHIVE](./archive/ARCHIVE.md).

---

## Step 1: Stop conversation

CopilotChat Stop must abort the pi run and in-flight tools, not only unsubscribe the UI. See [AGENT](./AGENT.md) §6.3c.

- [x] Call `LoomAgent.abort()` when the AG-UI run unsubscribes
- [x] Honor `AbortSignal` in Chat, bash, FFmpeg, VLM/Audio HTTP, embedding/rerank, and MCP
- [x] Persist the aborted turn; do not treat Stop as a Chat error. FFmpeg progress waits

## Step 2: Chat asset refs

Attach library assets in the composer (not only implicit `ui_selection`). Click `asset_id` citations in the thread to select that asset. See [AGENT](./AGENT.md) §5 and §6.3b.

- [ ] Composer chips on the user `attachments` sidecar; fold still goes to Chat as today
- [ ] Render refs from those chips and from `search_assets` / `inspect_asset`; click selects in the library
- [ ] Key by `asset_id`, never an absolute path

## Step 3: Branch from a message

Continue the current session from any turn, or fork a new session from that prefix. See [AGENT](./AGENT.md) §6.3d.

- [ ] Continue: later turns drop or park; the model sees the prefix through that message
- [ ] Fork: new session with the same prefix; the original transcript stays
- [ ] Today the store is linear append-only JSONL

---

## Later

- **In-process OCR (optional):** RapidOCR + ONNX on CPU, behind a switch, off by default. Not required. Prefer VLM. See [MEDIA](./RAG/MEDIA.md).
- **Dedicated ASR:** OpenAI-compatible `POST /v1/audio/transcriptions`. Prefer the Audio understanding slot. See [MEDIA](./RAG/MEDIA.md).
- **CLIP / image vectors:** embed the image without going through text; later if needed
- **Thinking:** surface model reasoning in chat. Add thinking events to `LoomAgentEvent`, map to AG-UI `THINKING_*`, drop redacted text, keep `thoughtSignature` off the frontend protocol. See [AGENT](./AGENT.md).
- **Skills:** load Agent Skills (`SKILL.md`, agentskills.io) into the creative Agent. Pi's harness already has the format; do not vendor `packages/coding-agent`. See [AGENT](./AGENT.md).
- **Multi-agent:** split collaboration and orchestration by genuine creative roles. See [PRODUCT](./PRODUCT.md) §10.
- **Sandbox:** path jail for workspace tools, plus a process sandbox for high-risk tools and generation jobs. See [PRODUCT](./PRODUCT.md) §10.
- **Evals:** Agent behavior, tool calls, and retrieval quality. Compaction rate and prompt-cache hit already live in `packages/agent/evals/`; Hybrid Search has a minimal unit set. See [PRODUCT](./PRODUCT.md) §10 and [AGENT](./AGENT.md).
- **FFmpeg progress:** stream protocol-level progress for long jobs (kill is Step 1)
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
