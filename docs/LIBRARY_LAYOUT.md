**English** | [简体中文](./LIBRARY_LAYOUT.zh-CN.md)

# Library layout

> Status: implemented. Everything Loom owns lives in one hidden `.loom/` directory, so the library root holds only user assets. `LibraryPaths` is the single owner of these paths.

## Target layout

```
<library>/                        -- user-owned; Loom imposes no structure
├── (user assets)
├── Inbox/                        -- composer imports; ordinary indexed folder
├── outputs/                      -- default tool output; ordinary indexed folder
│
└── .loom/                        -- everything Loom owns; never indexed
    ├── metadata-db/
    │   └── metadata.db           -- SQLite: assets, properties, metadata, vectors, FTS (+ -wal, -shm)
    ├── graph-db/
    │   └── graph.db/             -- LadybugDB EXPORT directory
    ├── grades/                   -- everything Grade owns
    │   └── luts/*.cube               -- LUTs imported from outside the library (was .loom/cache/luts/)
    └── agents/                   -- was <library>/.agents/
        ├── sessions/
        │   └── loom.sqlite       -- was .loom/loom.sqlite (+ -wal, -shm)
        ├── command-allows/
        │   └── command-allows.json   -- was .loom/command-allows.json
        ├── skills/               -- SKILL.md catalog
        ├── memory/MEMORY.md
        ├── traces/telemetry.sqlite   -- development only
        └── tool-results/<conversationId>/<taskId>.txt
```

`skills/`, `memory/`, `traces/`, and `tool-results/` keep their names and contents; they only move with their parent.

## Changes

| Item | From | To |
| --- | --- | --- |
| Asset index | `.loom/metadata.db` | `.loom/metadata-db/metadata.db` |
| Relation graph | `.loom/graph.db/` | `.loom/graph-db/graph.db/` |
| Agent directory | `.agents/` | `.loom/agents/` |
| Durable store | `.loom/loom.sqlite` | `.loom/agents/sessions/loom.sqlite` |
| Remembered commands | `.loom/command-allows.json` | `.loom/agents/command-allows/command-allows.json` |
| Grade records | `.loom/grades/<assetId>.json` | removed (nothing read them) |
| Imported LUTs | `.loom/cache/luts/` | `.loom/grades/luts/` |
| Grade temp files | `.loom/cache/grade-preview/`, `grade-frames/` | OS temp directory, outside the library |
| `thumbnails/` | `.loom/thumbnails/` | removed |
| `cache/` | `.loom/cache/` | removed |

`thumbnails/` is never written: the renderer shows the original file. `cache/` held only Grade files, and `luts/` in it is user data that Grade filters reference, not a cache, so it moves to `grades/`. Grade records, a per-output JSON recipe, were written on every export but never read back since the Grade view stopped restoring them, so they are no longer written. The temporary preview files (ffmpeg stills) leave the library for the OS temp directory: a crash leaves nothing in the user's library, and the OS cleans them up.

The library root no longer has a second reserved directory. `.agents` becomes an ordinary folder name the user may use.

## Code impact

- **One path owner.** `LibraryPaths.metadataDb` and `graphDb` point to the new locations, and `LibraryPaths` gains `agents`, `sessionsDb`, `commandAllows`, `skills`, `memory`, `traces`, and `toolResults`, replaces `grades` with `gradeLuts`, and drops `thumbnails` and `cache`. Hard-coded `".agents"` / `".loom"` joins are replaced by it. They currently live in:
  - `agent/src/runtime/library-runtime.ts` (twice)
  - `agent/src/extensions/library-skills.ts` (`LIBRARY_SKILLS_DIR`)
  - `agent/src/extensions/library-auto-memory.ts`
  - `agent/src/trace/trace-store.ts`
  - `agent/src/tools/tool-result-storage.ts`
  - `app/src/main/settings/command-allow-store.ts`
  - `core/src/library/library.ts` (creates `.agents/memory` on open)
  - `core/src/stores/sqlite.ts` (`mkdir(paths.loom)` must create `metadata-db/`) and `core/src/stores/ladybug.ts` (already creates `dirname(graphDb)`; its `graph.db.tmp` staging directory stays beside `graph.db`)
  - `core/src/media/service.ts` and `core/src/local-core.ts` (grade temp files, LUT import, `grade/store.ts` callers). The media service removes its scratch directory when the library closes, instead of relying on the in-memory frame map alone. See [Temporary files](#temporary-files).
- **Ignore rules.** `.loom/` already covers everything. Remove `isAgentsPath`, and drop `.agents` from `isIgnoredPath`, the reserved names in `library.ts` `placeOnePath`, and `containedLibraryPath` in `app/src/main/index.ts`. Keep `.loom` and `.DS_Store`.
- **Model-visible paths.** Tool-result previews and the skills catalog show library paths. They change to `.loom/agents/...`. Check that `read` and the process sandbox accept reading inside `.loom/`.
- **Sandbox.** `bash`, `ffmpeg`, and `ffprobe` may write the whole library, so they could already write `.loom/`. Moving skills and memory under it adds no new exposure, but the Agent can now also reach `metadata.db` and `loom.sqlite` through the same paths as before.
- **Platforms.** Use `path.join` everywhere. Create parent directories before opening any store.

## Migration

None. The new build reads only the new paths and never touches the old ones. An existing library opens as if new:

- `.loom/metadata-db/` is created empty and the files are re-indexed. Asset IDs are regenerated, and everything stored only in the old `metadata.db` is lost: favorites, tags, custom properties, and asset relations (the old `graph.db`).
- Chat history, skills, memory, and remembered commands are not found at the new paths.
- The old `.agents/`, `.loom/loom.sqlite*`, `.loom/command-allows.json`, `.loom/metadata.db*`, `.loom/graph.db/`, `.loom/grades/*.json` (old grade records), and `.loom/cache/` are left in place and never deleted. A user who wants them may move them by hand while Loom is closed. Move `metadata.db` with its `-wal` and `-shm`.
- An older build cannot read a library the new build has written to: it would see an empty `.loom/loom.sqlite`. Back up `.loom/` and `.agents/` before first opening with the new build.

## Temporary files

Everything Loom writes to the OS temp directory lives under one root, `<os.tmpdir()>/loom/`, in a subdirectory named for its purpose. `core/src/temp.ts` is the only code that builds these paths.

```
<os.tmpdir()>/loom/
├── grade/run-*/{preview,frames}/   -- ffmpeg stills for the Grade panel; one run-* per media service
├── vlm-frames/run-*/               -- video frames sent to the VLM; removed after each asset
├── audio/run-*/                    -- compacted audio for transcription; removed after each asset
├── composer/run-*/                 -- clipboard images on their way into Inbox/; removed after import
├── sandbox/                        -- process sandbox spec files and the spawn helper script
└── e2e/<pid>/                      -- Electron userData for Playwright runs
```

- `os.tmpdir()` follows `TMPDIR` (macOS/Linux) or `TEMP`/`TMP` (Windows) and never checks the directory exists. `ensureTempRoot()` creates it. Never hard-code `/tmp`: the process sandbox can write only the library and `canonical(tmpdir())`.
- Short-lived folders (`vlm-frames`, `audio`, `composer`, `grade/run-*`) are removed by their owner. At app start `sweepStaleTemp()` removes anything under the root older than 24 hours, which covers crashes. It is best effort and never fails startup.
- The sandbox creates Unix sockets inside the temp directory, and socket paths are limited to about 104 bytes. A very deep `TMPDIR` stops the sandbox from starting.

### Tests

`pnpm test`, `pnpm --filter @loom/agent test:vendor`, and `test:e2e` run through `scripts/with-test-tmp.mjs`. It creates one short `lt-*` directory, points `TMPDIR`/`TEMP`/`TMP` at it, runs the command, and deletes the directory on exit, on failure, and on Ctrl-C. Tests keep calling `mkdtemp(tmpdir())`; nothing they leave behind reaches the real temp directory. `test:e2e:attach` talks to a running `pnpm dev` and is not wrapped.

## Docs and tests to update

- Docs: PRODUCT §3.1 and §3.2, SETTINGS (drop the `config.json` mention if it is dead), `agent/AGENT`, `agent/MEMORY`, `agent/TRACE`, `agent/PERMISSION`, README; each with its `zh-CN` twin.
- Tests: `core/tests/library-paths.test.ts`, `core/tests/library.test.ts` (both assert `.loom/metadata.db`), `agent/tests/{library-skills,tool-result-storage,durable-trace,trace-recorder}.test.ts`, `agent/vendor-tests/library-runtime.test.ts`, `app/tests/{command-allow-store,ag-ui-adapter}.test.ts`, the LUT import test, `app/e2e/smoke.spec.ts`.
