[简体中文](./CLEANUP.zh-CN.md) | **English**

# Cleanup backlog

> Places that are dead, duplicated, named after a design that no longer holds, or entangled so that no part can be read alone. This is not a feature roadmap (see [TODO](./TODO.md)); every entry here should end in deletion, reconnection, a renamed concept, or a decomposition.
> An entry needs: what is out of shape, why, the concrete symbols involved, and the decision that unblocks cleanup.

---

## 1. Bind asset jobs to the library lifecycle

**Problem:** `LocalCore.openLibrary()` / `close()` switch or close storage without settling enrichment, embedding, and multimodal jobs. Reproduced with image description: start in library A, switch to B, then receive `Asset not found`; reopening A leaves the record `describing` and the details button disabled.

**Scope:** `core/src/local-core.ts`, `enrichment/service.ts`, `rag/service.ts`, `rag/{image-vlm,video-vlm,audio-writeup}.ts`, app `applyOpenedLibrary()`, and details status display.

**Direction:** Bind jobs and writes to the library where they started. Cancel or drain jobs before switching storage or closing. Recover interrupted `describing` / `embedding` records; old jobs must not write results or emit updates into the new library.

**Acceptance:** Switching while requests run or queue, closing, and reopening cannot cross library boundaries or leave an operation permanently unavailable for retry.

## 2. Share the multimodal description workflow

**Problem:** `core/src/rag/image-vlm.ts`, `video-vlm.ts`, and `audio-writeup.ts` repeat serial queues, cache freshness checks, status transitions, error handling, and record updates.

**Direction:** Complete job lifecycle work in item 1 first, then extract the shared execution flow. Media implementations retain image reading, native video / frame extraction, audio preparation, and their provider contracts. Share status handling without introducing an inheritance hierarchy.

**Acceptance:** All three media types follow consistent cache, failure, cancellation, and notification rules; media-specific input constraints and preparation retain their own coverage.

## 3. Split entry files with mixed responsibilities

**Problem:** Feature directories now exist, but `app/src/main/index.ts`, `app/src/renderer/App.tsx`, and `core/src/local-core.ts` still concentrate several responsibilities.

**Direction:** First extract asset protocol handling, feature-specific IPC registration, and settings coordination from Main, leaving startup composition and lifecycle management. Extract library operations, selection, and asset job state from App. Keep LocalCore as the domain facade and place retrieval and media implementations in their respective modules. Split by responsibility rather than moving a whole large file under another name.

**Acceptance:** UI and tools still share one domain entry; business rules are not duplicated; relevant IPC, desktop, and domain tests pass.

---

## Rules

- One entry per stale or entangled surface, with the symbols named.
- Record the decision, not the discussion.
- Delete an entry when the code is gone; log finished work in the [archive](./archive/ARCHIVE.md).
