[简体中文](./CLEANUP.zh-CN.md) | **English**

# Cleanup backlog

> Places that are dead, duplicated, named after a design that no longer holds, or entangled so that no part can be read alone. This is not a feature roadmap (see [TODO](./TODO.md)); every entry here should end in deletion, reconnection, a renamed concept, or a decomposition.
> An entry needs: what is out of shape, why, the concrete symbols involved, and the decision that unblocks cleanup.

---

## 1. Split entry files with mixed responsibilities

**Problem:** Feature directories now exist, but `app/src/main/index.ts`, `app/src/renderer/App.tsx`, and `core/src/local-core.ts` still concentrate several responsibilities.

**Direction:** First extract asset protocol handling, feature-specific IPC registration, and settings coordination from Main, leaving startup composition and lifecycle management. Extract library operations, selection, and asset job state from App. Keep LocalCore as the domain facade and place retrieval and media implementations in their respective modules. Split by responsibility rather than moving a whole large file under another name.

**Acceptance:** UI and tools still share one domain entry; business rules are not duplicated; relevant IPC, desktop, and domain tests pass.

---

## Rules

- One entry per stale or entangled surface, with the symbols named.
- Record the decision, not the discussion.
- Delete an entry when the code is gone; log finished work in the [archive](./archive/ARCHIVE.md).
