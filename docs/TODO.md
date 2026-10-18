**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./agent/AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.
> Completed work is in the [archive](./archive/ARCHIVE.md). Stale or dead surfaces awaiting removal are in [CLEANUP](./CLEANUP.md).

---

## Current: Chat regression and delivery

Remaining acceptance checklist: [CHAT_MODELS](./agent/CHAT_MODELS.md) P4/P5.

- Show image-capability hints after model changes.
- Validate native OpenAI/Anthropic/Google services and real OAuth login/refresh/logout; test interactive login/logout races.
- Complete the four-protocol tool-call/usage/cancellation and cross-protocol/provider history conversion matrix.
- Recheck on a Mac and validate packaged runtime on macOS/Windows.

---

## Eval set improvement

- Improve the eval set and add real-task evaluation: replace and extend the simple goldens in `tasks.ts` with real creative tasks, covering multi-step tools, media output, and failure paths. See [EVALS](./agent/EVALS.md).

---

## Step 1: LangGraph

Add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.

---

## Step 2: Deeper memory

`MEMORY.md` is only an index. Entry bodies live elsewhere. A dreaming pass may consolidate, merge, and forget while idle.

---

## Step 3: Multi-tab material viewing

Consider supporting multiple tabs for viewing library items.
