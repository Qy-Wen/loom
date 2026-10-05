**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [Pi Harness integration scope (Chinese)](./PI-HARNESS.md), [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.

---

## Step 1: Multi-agent

Split collaboration by genuine creative roles, not a generic orchestrator. See [PRODUCT](./PRODUCT.md) §10.

The user-facing chat Agent talks, plans, and transforms (FFmpeg). Nested specialists:

- [x] Retrieve Agent: search and inspect the library; return asset ids and passages
- [x] Create Agent: generate from a brief via MCP; do not search the library. Asset ids go in the brief when the task needs them
- [x] Run independent calls in parallel in the first version (the harness already schedules parallel tools). A child cannot spawn another child

## Step 2: Process sandbox

High-risk work (bash, FFmpeg, generation jobs) runs isolated from the rest of the machine.

- [ ] Isolate those processes so a bad argv cannot touch files outside the intended scope

---

## Later

- **Observability:** per-run tool / latency / token traces via pi-telemetry (spans exist, currently no-op). Do not add a second tracing stack. Lifetime Stats already exist.
- **LangGraph:** add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.
- **Memory:** remember user preferences and creative conventions across sessions so later chats can use them.
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
