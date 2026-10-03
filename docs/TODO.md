**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [Pi Harness integration scope (Chinese)](./PI-HARNESS.md), [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them. Path jail and sandbox come later.

---

Do not add prompt-template UI merely because vendor APIs exist.

## Step 1: Automatic threshold compaction ✅

Enabled the vendor's automatic threshold compaction (16,384 tokens reserved, ~20,000 tokens of recent context kept). Chat Settings gained an optional context-window field with a 128k fallback; compaction events forward to AG-UI and compaction summaries render in the transcript. Real-model verification lives in `packages/agent/evals/compaction-e2e.ts` (trigger, anchor retention, and post-compaction recall all pass).

- [x] Optional Chat contextWindow setting with `?? 128000` fallback
- [x] Enable automatic threshold compaction and forward compaction events (overflow recovery included)
- [x] Verify with a real model: threshold triggers and summaries retain key semantics (anchor facts recallable after compaction)

## Step 2: Follow-up while a run is active ✅

Enter while a run is active queues the text as vendor `followUp`. The same run continues at the checkpoint where it would otherwise finish, inserting one queued follow-up at a time and waiting until that stretch ends before inserting the next. Queued text is listed above the composer; once inserted it leaves the queue and appears as a user message. Stop still discards follow-ups that have not been inserted. `steer` and `nextRun` are unused. The queue is written into the Harness session, so a crash mid-run keeps it; a clean Stop does not.

- [x] Mid-run Enter queues `followUp`; insertion removes it from the queue and shows it in the thread, and Stop drops follow-ups that have not been inserted
- [x] Wire the vendor follow-up queue so the same run continues, and Stop still drops unconsumed follow-ups

## Step 3: Branch from a previous question

Use the harness session tree to continue from an earlier user question in the current session or fork a new session. Do not revert files the agent already wrote. See [AGENT](./AGENT.md) §6.3d.

- [ ] Continue: switch the active path; preserve the old path in the tree; decide whether to expose a way back
- [ ] Fork: new session from the selected prefix; leave the original session intact
- [ ] Decide whether selecting a question includes it in context or restores it to the composer for editing before implementing the UI
- [ ] Leave workspace files as they are; no checkpoint restore

## Step 4: Chat asset refs

Attach library assets in the composer (not only implicit `ui_selection`). Click `asset_id` citations in the thread to select that asset. See [AGENT](./AGENT.md) §5 and §6.3b.

- [ ] Composer chips on the user `attachments` sidecar; fold still goes to Chat as today
- [ ] Render refs from those chips and from `search_assets` / `inspect_asset`; click selects in the library
- [ ] Key by `asset_id`, never an absolute path

## Step 5: Skills

Load `SKILL.md` from the open library into the creative Agent running on pi harness. See [AGENT](./AGENT.md).

- [ ] Read Agent Skills (`SKILL.md`, agentskills.io) from the library. Do not vendor `packages/coding-agent`
- [ ] Put a matching skill's text in the system prompt, or expose it as a tool the agent reads on demand

---

## Later

- **In-process OCR (optional):** RapidOCR + ONNX on CPU, behind a switch, off by default. Not required. Prefer VLM. See [MEDIA](./RAG/MEDIA.md).
- **Dedicated ASR:** OpenAI-compatible `POST /v1/audio/transcriptions`. Prefer the Audio understanding slot. See [MEDIA](./RAG/MEDIA.md).
- **CLIP / image vectors:** embed the image without going through text; later if needed
- **Multi-agent:** split collaboration and orchestration by genuine creative roles. See [PRODUCT](./PRODUCT.md) §10.
- **Sandbox:** path jail for workspace tools, plus a process sandbox for high-risk tools and generation jobs. See [PRODUCT](./PRODUCT.md) §10.
- **Evals:** Agent behavior, tool calls, and retrieval quality. Compaction rate and prompt-cache hit already live in `packages/agent/evals/`; Hybrid Search has a minimal unit set. See [PRODUCT](./PRODUCT.md) §10 and [AGENT](./AGENT.md).
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
