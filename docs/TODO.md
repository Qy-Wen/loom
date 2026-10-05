**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.

---

## Step 1: Auto memory

Remember user preferences and creative conventions across sessions. See [MEMORY](./agent/MEMORY.md).

- [x] Keep the notes in the open library's `.agents/memory/`. Create that folder when the library opens if it is missing. Do not index it as assets. A small always-on note goes in the system prompt, frozen when the session starts. Writes during the session persist; the next session reads them. Facts only. Procedures stay in skills
- [x] The agent adds, replaces, and removes entries with a tool. The tool result shows the live notes. The system prompt snapshot stays frozen until the next session
- [ ] Recall that depends on the current message is appended in that same user message, inside `<system-reminder>`, with the library highlight. No second user message. Nothing selected and nothing recalled: no reminder

## Step 2: Process sandbox

High-risk work (bash, FFmpeg, generation jobs) runs isolated from the rest of the machine.

- [ ] Isolate those processes so a bad argv cannot touch files outside the intended scope

---

## Later

- **Observability:** per-run tool / latency / token traces via pi-telemetry (spans exist, currently no-op). Do not add a second tracing stack. Lifetime Stats already exist.
- **LangGraph:** add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.
- **Publishing:** adapters for Xiaohongshu, Douyin, and other platforms
