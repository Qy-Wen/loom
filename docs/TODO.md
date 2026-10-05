**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.

---

## Step 1: Process sandbox

bash and FFmpeg run in a sandbox. Generation stays MCP and is not wrapped in this sandbox. See [PERMISSION](./AGENT/PERMISSION.md).

- [x] Isolate bash and FFmpeg so a bad argv cannot touch files outside that scope

---

## Later

- **Observability:** per-run tool / latency / token traces via pi-telemetry (spans exist, currently no-op). Do not add a second tracing stack. Lifetime Stats already exist.
- **LangGraph:** add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
