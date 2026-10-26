**English** | [简体中文](./LIBRARY_LAYOUT.zh-CN.md)

# Library layout

> Status: proposal. Moves everything Loom owns into one hidden `.loom/` directory, so the library root holds only user assets. Replaces the layout in [PRODUCT.md](./PRODUCT.md) §3.1 once accepted.

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
    │   ├── records/<assetId>.json    -- recipe of each graded output (was .loom/grades/*.json)
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
| Grade records | `.loom/grades/<assetId>.json` | `.loom/grades/records/<assetId>.json` |
| Imported LUTs | `.loom/cache/luts/` | `.loom/grades/luts/` |
| Grade temp files | `.loom/cache/grade-preview/`, `grade-frames/` | OS temp directory, outside the library |
| `thumbnails/` | `.loom/thumbnails/` | removed |
| `cache/` | `.loom/cache/` | removed |

`thumbnails/` is never written: the renderer shows the original file. `cache/` held only Grade files, and `luts/` in it is user data referenced by grade records, not a cache. Records and LUTs move under `grades/`, so Grade has one owner directory. The temporary preview files (ffmpeg stills) leave the library for the OS temp directory: a crash leaves nothing in the user's library, and the OS cleans them up.

The library root no longer has a second reserved directory. `.agents` becomes an ordinary folder name the user may use.

## Code impact

- **One path owner.** `LibraryPaths.metadataDb` and `graphDb` point to the new locations, and `LibraryPaths` gains `agents`, `sessionsDb`, `commandAllows`, `skills`, `memory`, `traces`, and `toolResults`, replaces `grades` with `gradeRecords` and `gradeLuts`, and drops `thumbnails` and `cache`. Hard-coded `".agents"` / `".loom"` joins are replaced by it. They currently live in:
  - `agent/src/runtime/library-runtime.ts` (twice)
  - `agent/src/extensions/library-skills.ts` (`LIBRARY_SKILLS_DIR`)
  - `agent/src/extensions/library-auto-memory.ts`
  - `agent/src/trace/trace-store.ts`
  - `agent/src/tools/tool-result-storage.ts`
  - `app/src/main/settings/command-allow-store.ts`
  - `core/src/library/library.ts` (creates `.agents/memory` on open)
  - `core/src/stores/sqlite.ts` (`mkdir(paths.loom)` must create `metadata-db/`) and `core/src/stores/ladybug.ts` (already creates `dirname(graphDb)`; its `graph.db.tmp` staging directory stays beside `graph.db`)
  - `core/src/media/service.ts` and `core/src/local-core.ts` (grade temp files, LUT import, `grade/store.ts` callers). Temp files live in one private directory per media service, created with `mkdtemp(join(os.tmpdir(), "loom-grade-"))` before first use (never a fixed path such as `/tmp`, which the sandbox cannot write). Do not hard-code `/tmp`; `os.tmpdir()` follows `TMPDIR`/`TEMP`, and on macOS it is normally `/var/folders/.../T`. The process sandbox already allows read and write on `canonical(tmpdir())`. Remove the directory when the media service closes, instead of relying on the in-memory frame map alone. Verify once, with the sandbox on, that ffmpeg can write a jpg into that directory on macOS and Windows
- **Ignore rules.** `.loom/` already covers everything. Remove `isAgentsPath`, and drop `.agents` from `isIgnoredPath`, the reserved names in `library.ts` `placeOnePath`, and `containedLibraryPath` in `app/src/main/index.ts`. Keep `.loom` and `.DS_Store`.
- **Model-visible paths.** Tool-result previews and the skills catalog show library paths. They change to `.loom/agents/...`. Check that `read` and the process sandbox accept reading inside `.loom/`.
- **Sandbox.** `bash`, `ffmpeg`, and `ffprobe` may write the whole library, so they could already write `.loom/`. Moving skills and memory under it adds no new exposure, but the Agent can now also reach `metadata.db` and `loom.sqlite` through the same paths as before.
- **Platforms.** Use `path.join` everywhere. Create parent directories before opening any store.

## Migration

None. The new build reads only the new paths and never touches the old ones. An existing library opens as if new:

- `.loom/metadata-db/` is created empty and the files are re-indexed. Asset IDs are regenerated, and everything stored only in the old `metadata.db` is lost: favorites, tags, custom properties, and asset relations (the old `graph.db`).
- Chat history, skills, memory, remembered commands, and grade records are not found at the new paths.
- The old `.agents/`, `.loom/loom.sqlite*`, `.loom/command-allows.json`, `.loom/metadata.db*`, `.loom/graph.db/`, `.loom/grades/*.json`, and `.loom/cache/` are left in place and never deleted. A user who wants them may move them by hand while Loom is closed. Move `metadata.db` with its `-wal` and `-shm`, and a grade record's `lut` field still points at the old `.loom/cache/luts/` path.
- An older build cannot read a library the new build has written to: it would see an empty `.loom/loom.sqlite`. Back up `.loom/` and `.agents/` before first opening with the new build.

## Docs and tests to update

- Docs: PRODUCT §3.1 and §3.2, SETTINGS (drop the `config.json` mention if it is dead), `agent/AGENT`, `agent/MEMORY`, `agent/TRACE`, `agent/PERMISSION`, README; each with its `zh-CN` twin.
- Tests: `core/tests/library-paths.test.ts`, `core/tests/library.test.ts` (both assert `.loom/metadata.db`), `agent/tests/{library-skills,tool-result-storage,durable-trace,trace-recorder}.test.ts`, `agent/vendor-tests/library-runtime.test.ts`, `app/tests/{command-allow-store,ag-ui-adapter}.test.ts`, any grade store and LUT import tests, `app/e2e/smoke.spec.ts`.
