**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [Pi Harness integration scope (Chinese)](./PI-HARNESS.md), [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them. Path jail and sandbox come later.

---

Automatic threshold compaction remains later work. Do not add prompt-template or steering UI merely because vendor APIs exist.

## Step 1: Branch from a previous question

Use the harness session tree to continue from an earlier user question in the current session or fork a new session. Do not revert files the agent already wrote. See [AGENT](./AGENT.md) §6.3d.

- [ ] Continue: switch the active path; preserve the old path in the tree; decide whether to expose a way back
- [ ] Fork: new session from the selected prefix; leave the original session intact
- [ ] Decide whether selecting a question includes it in context or restores it to the composer for editing before implementing the UI
- [ ] Leave workspace files as they are; no checkpoint restore

## Step 2: Chat asset refs

Attach library assets in the composer (not only implicit `ui_selection`). Click `asset_id` citations in the thread to select that asset. See [AGENT](./AGENT.md) §5 and §6.3b.

- [ ] Composer chips on the user `attachments` sidecar; fold still goes to Chat as today
- [ ] Render refs from those chips and from `search_assets` / `inspect_asset`; click selects in the library
- [ ] Key by `asset_id`, never an absolute path

## Step 3: Skills

Load `SKILL.md` from the open library into the creative Agent running on pi harness. See [AGENT](./AGENT.md).

- [ ] Read Agent Skills (`SKILL.md`, agentskills.io) from the library. Do not vendor `packages/coding-agent`
- [ ] Put a matching skill's text in the system prompt, or expose it as a tool the agent reads on demand

---

## Later

- **Automatic threshold compaction:** configure the real Chat context window, verify when threshold compaction triggers, and ensure summaries retain attachment meaning; deferred from the Harness cutover.
- **In-process OCR (optional):** RapidOCR + ONNX on CPU, behind a switch, off by default. Not required. Prefer VLM. See [MEDIA](./RAG/MEDIA.md).
- **Dedicated ASR:** OpenAI-compatible `POST /v1/audio/transcriptions`. Prefer the Audio understanding slot. See [MEDIA](./RAG/MEDIA.md).
- **CLIP / image vectors:** embed the image without going through text; later if needed
- **Multi-agent:** split collaboration and orchestration by genuine creative roles. See [PRODUCT](./PRODUCT.md) §10.
- **Sandbox:** path jail for workspace tools, plus a process sandbox for high-risk tools and generation jobs. See [PRODUCT](./PRODUCT.md) §10.
- **Evals:** Agent behavior, tool calls, and retrieval quality. Compaction rate and prompt-cache hit already live in `packages/agent/evals/`; Hybrid Search has a minimal unit set. See [PRODUCT](./PRODUCT.md) §10 and [AGENT](./AGENT.md).
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
