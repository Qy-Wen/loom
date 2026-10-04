**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [Pi Harness integration scope (Chinese)](./PI-HARNESS.md), [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.

---

## Step 1: Multi-agent

Split collaboration by genuine creative roles, not a generic orchestrator. See [PRODUCT](./PRODUCT.md) §10.

- [ ] Add a second Agent only when two roles would otherwise fight in one loop (for example retrieve vs create)

## Step 2: Process sandbox

High-risk work (bash, FFmpeg, generation jobs) runs isolated from the rest of the machine.

- [ ] Isolate those processes so a bad argv cannot touch files outside the intended scope

---

## Later

- **Observability:** per-run tool / latency / token traces via pi-telemetry (spans exist, currently no-op). Do not add a second tracing stack. Lifetime Stats already exist.
- **LangGraph:** add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
