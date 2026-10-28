**English** | [简体中文](./TODO.zh-CN.md)

# TODO

> Flat roadmap checklist. See [PRODUCT.md](./PRODUCT.md) for product design, [AGENT.md](./agent/AGENT.md) for the Agent architecture, [SETTINGS.md](./SETTINGS.md) for model endpoints, and [RAG](./RAG/RAG.md) for retrieval.
> Only the next steps are detailed; later work stays at summary level.
> Creation tools (ComfyUI and later) attach as MCP servers. Loom-owned tools stay the library: search, FFmpeg, and workspace tools. Files land in the library via write/bash; the watcher indexes them.
> Completed work is in the [archive](./archive/ARCHIVE.md).

---

## Current: Chat regression and delivery

Remaining acceptance:

- Validate native OpenAI/Anthropic/Google services and real OAuth token refresh.
- Complete the four-protocol tool-call/usage/cancellation and cross-protocol/provider history conversion matrix.

---

## Eval set improvement

- Improve the eval set and add real-task evaluation: replace and extend the simple goldens in `tasks.ts` with real creative tasks, covering multi-step tools, media output, and failure paths. See [EVALS](./agent/EVALS.md).

---

## Search and index refactor

Three steps in [SEARCH](./RAG/SEARCH.md): the index reads the original file, chunk full-text with Chinese tokenizing, and a split into simple and deep search.

- Later option: split chunking from vectors so chunking and chunk full-text finish in the background after the extract. It needs a background task that can be cancelled and yields to the event loop first.

---

## Split the entry files

`app/src/main/index.ts` (about 1,500 lines), `app/src/renderer/App.tsx` (about 1,350), and `core/src/local-core.ts` (about 730) each carry several responsibilities. Split by responsibility in steps; do not just move a whole file under a new name:

- Main entry: move out the asset protocol, IPC registration grouped by feature, and settings coordination. The entry keeps only startup wiring and lifecycle.
- App: extract library operations, selection, and asset-job state.
- LocalCore: keep the domain entry points and move retrieval, media processing, and similar implementations into their own modules.

Done when the UI and tools still work through the same domain entry points, no business rule is duplicated, and the related IPC, desktop-flow, and domain tests pass.

---

## Step 1: LangGraph

Add a controlled-flow branch beside the chat Agent, and run tasks through fixed steps. See [PRODUCT](./PRODUCT.md) §10.

---

## Step 2: Deeper memory

`MEMORY.md` is only an index. Entry bodies live elsewhere. A dreaming pass may consolidate, merge, and forget while idle.
