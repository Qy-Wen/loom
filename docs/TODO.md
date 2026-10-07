**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.

---

## Step 1: Observability

One prompt's run, turn, step, tool, and model-request spans stay in memory. In development, a separate Traces window shows each prompt as a span waterfall. Click a tool or model span to read its arguments and result, or the messages sent and the reply. Each side is truncated. That window is not part of the packaged app. Do not add a second tracing stack. Lifetime Stats already exist.

---

## Step 2: LangGraph

Add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.

---

## Step 3: Publishing

Adapters for Xiaohongshu, Douyin, and other platforms.

---

## Step 4: Packaging

Consider shipping installable builds for macOS and Windows.
