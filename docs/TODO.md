**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.

---

## Step 1: LangGraph

Add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.

---

## Step 2: Graph retrieval

Retrieve by walking relations, so a search or an answer follows the graph and brings back connected files.

---

## Step 3: Publishing

Adapters for Xiaohongshu, Douyin, and other platforms.

---

## Step 4: Packaging

Consider shipping installable builds for macOS and Windows.

---

## Step 5: Deeper memory

`MEMORY.md` is only an index. Entry bodies live elsewhere. A dreaming pass may consolidate, merge, and forget while idle.

---

## Step 6: Finer permissions

When the user approves an operation, they can allow that command from then on, without another prompt. Choosing Full asks once more, and tells the user that this turns off the sandbox and lets the agent run every operation.
