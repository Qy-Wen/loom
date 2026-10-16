**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./agent/AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.

---

## Current: Full Chat integration with pi-ai

Agreed scope and phased checklist: [CHAT_MODELS](./agent/CHAT_MODELS.md). Native Providers/catalogs, API-key/OAuth login, encrypted Chat credentials, and provider/default settings UI are live in production; legacy endpoint compatibility is removed. App defaults affect only new conversations; other model slots remain unchanged. Remaining: per-conversation model selection (P4) and Windows/live-OAuth regression (P5).

---

## Step 1: LangGraph

Add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.

---

## Step 2: Publishing

Adapters for Xiaohongshu, Douyin, and other platforms.

---

## Step 3: Deeper memory

`MEMORY.md` is only an index. Entry bodies live elsewhere. A dreaming pass may consolidate, merge, and forget while idle.

---

## Step 4: Easier model setup

Chat setup is covered by the current [pi-ai integration](./agent/CHAT_MODELS.md). Later, lower the setup barrier for the remaining model slots.

---

## Step 5: Multi-tab material viewing

Consider supporting multiple tabs for viewing library items.
