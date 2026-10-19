[简体中文](./CLEANUP.zh-CN.md) | **English**

# Cleanup backlog

> Places that are dead, duplicated, named after a design that no longer holds, or entangled so that no part can be read alone. This is not a feature roadmap (see [TODO](./TODO.md)); every entry here should end in deletion, reconnection, a renamed concept, or a decomposition.
> An entry needs: what is out of shape, why, the concrete symbols involved, and the decision that unblocks cleanup.

---

## 1. Unify settings persistence and fix concurrent saves

**Problem:** `ModelSettingsStore.update()` does not serialize read-modify-write operations, and `save()` overwrites the file directly. Settings UI and the agent's `update_settings` can run concurrently; temporary-file reproductions lost updates and produced invalid JSON. Renderer `SettingsSaveQueue` protects only that settings page.

**Scope:** `app/src/main/models/model-settings-store.ts`, `main/settings/*-store.ts`, `main/mcp/store.ts`, and settings IPC / `applySettingsPatch()` in `main/index.ts`. Atomic writes and file locking already exist in `main/models/chat-file.ts`.

**Direction:** Extract shared file persistence primitives. Serialize reading, applying patches, and atomic commits in Main; callers submit actual changes so stale full drafts cannot overwrite other updates. Each feature retains its validation and storage types.

**Acceptance:** Concurrent UI and agent changes preserve both updates; readers always see complete files; failed writes preserve the last saved result. Cover replacement behavior on macOS and Windows.

## 2. Bind asset jobs to the library lifecycle

**Problem:** `LocalCore.openLibrary()` / `close()` switch or close storage without settling enrichment, embedding, and multimodal jobs. Reproduced with image description: start in library A, switch to B, then receive `Asset not found`; reopening A leaves the record `describing` and the details button disabled.

**Scope:** `core/src/local-core.ts`, `enrichment/service.ts`, `rag/service.ts`, `rag/{image-vlm,video-vlm,audio-writeup}.ts`, app `applyOpenedLibrary()`, and details status display.

**Direction:** Bind jobs and writes to the library where they started. Cancel or drain jobs before switching storage or closing. Recover interrupted `describing` / `embedding` records; old jobs must not write results or emit updates into the new library.

**Acceptance:** Switching while requests run or queue, closing, and reopening cannot cross library boundaries or leave an operation permanently unavailable for retry.

## 3. Remove interfaces left behind by the remembered-command list UI

**Problem:** The Remembered commands list UI is gone, but `removeCommandAllow` still spans Main, preload, and shared with no in-repo consumer. Only tests call `commandAllowLabel()`.

**Scope:** The removal handler in `app/src/main/index.ts`, `src/preload/index.ts`, `src/shared/ipc.ts`, `remove()` in `main/settings/command-allow-store.ts`, and `commandAllowLabel()` in `agent/src/tools/tool-permission.ts`, plus their tests.

**Direction:** Delete the unused removal interface and display helper. Reading, saving, binding, change notifications, and permission matching still serve tool cards and approvals and must remain.

**Acceptance:** No obsolete removal channel or display helper remains; per-library remembered grants and tool approvals still work.

## 4. Share the multimodal description workflow

**Problem:** `core/src/rag/image-vlm.ts`, `video-vlm.ts`, and `audio-writeup.ts` repeat serial queues, cache freshness checks, status transitions, error handling, and record updates.

**Direction:** Complete job lifecycle work in item 2 first, then extract the shared execution flow. Media implementations retain image reading, native video / frame extraction, audio preparation, and their provider contracts. Share status handling without introducing an inheritance hierarchy.

**Acceptance:** All three media types follow consistent cache, failure, cancellation, and notification rules; media-specific input constraints and preparation retain their own coverage.

## 5. Split entry files with mixed responsibilities

**Problem:** Feature directories now exist, but `app/src/main/index.ts`, `app/src/renderer/App.tsx`, and `core/src/local-core.ts` still concentrate several responsibilities.

**Direction:** First extract asset protocol handling, feature-specific IPC registration, and settings coordination from Main, leaving startup composition and lifecycle management. Extract library operations, selection, and asset job state from App. Keep LocalCore as the domain facade and place retrieval and media implementations in their respective modules. Split by responsibility rather than moving a whole large file under another name.

**Acceptance:** UI and tools still share one domain entry; business rules are not duplicated; relevant IPC, desktop, and domain tests pass.

## 6. Align evaluation and production Embedding HTTP implementations

**Problem:** `core/evals/http-embed.ts` and `app/src/main/models/embedding-provider.ts` duplicate requests and response parsing. URL semantics have diverged: evaluation appends an operation path, while production accepts a complete request URL.

**Direction:** Share HTTP request / response adaptation independently of Electron. Explicitly separate evaluation environment-variable URL assembly from production configuration semantics; core must not depend on app. Cover both entry points with the same protocol fixtures before deduplication.

**Acceptance:** Production and evaluation share protocol contract tests; complete URLs are preserved; live evaluation results identify the implementation actually reused.

---

## Rules

- One entry per stale or entangled surface, with the symbols named.
- Record the decision, not the discussion.
- Delete an entry when the code is gone; log finished work in the [archive](./archive/ARCHIVE.md).
