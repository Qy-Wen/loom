**English** | [简体中文](./README.zh-CN.md)

# Loom

Local-first AI workbench for creative asset management. The filesystem is the source of truth, SQLite and a graph database are the cognitive layer, and the Agent is the operational layer.

## Product

Loom turns a folder into your asset library. A personal photo album, drafts and finished pieces from a project, and images or video you keep for reference can live in one place, where you can look through them and find them again. You keep the directory layout. Copy the whole folder to another machine and open it there. Rename and move, and the tags, favorites, and relations stay.

**Files.** The library sits on the left. The file tree switches between a list and icons. Open an image, a video, an audio clip, a PDF, or a note, and it previews in the center. Markdown renders by default, with a source view. Favorite a file, or tag it, and gather the same kind of asset under that tag.

**Understanding and search.** Multimodal models write descriptions of images, video, and audio, and those descriptions are embedded in a vector database. You can then search by meaning: a loose phrase finds a similar frame, shot, or sound when the filename is forgotten. You choose which assets to describe and embed.

**Asset graph.** You decide how assets are related. A reference image, the picture made from it, and the video cut from that picture can be linked with edges such as "derived from" or "reference", and grow into a graph of your own. A set of photos, the assets of one project, and the references you collect for a hobby all show where they came from and how they connect. Edges can be viewed, added, and removed.

**Custom table.** Beside the folders, assets can sit in a table you define. Columns are yours: status, project, rating, as text, number, checkbox, or date. You can add a column, fill a cell, rename it, or delete it. So can the agent.

**Image and video.** Loom integrates FFmpeg, a professional tool for images and video. Use it to crop, grade color, transcode, and compress, and also to pull a frame or cut a clip. This runs locally, and the finished file returns to the library.

**Creation.** Creative tools attach over MCP. ComfyUI is one. The agent calls them to make something new, writes the file back into the library, and records on the graph which assets it came from.

**Publishing.** Publishing finished work to social platforms is planned, so finding an asset, making a piece, and posting it can stay in the same workbench.

**Through conversation.** Search, the table, relations, image and video work, and creation are all available to the agent. Ask it to find an asset by what it shows or sounds like, change a column, draw a relation, use FFmpeg to crop, grade, transcode, or compress, or have ComfyUI make a new image. Place a library file in the composer, and it knows which one you mean.

## Agent

Built on [pi durable](https://github.com/earendil-works/pi/tree/main/packages/durable). Durable and codemode are vendored from the same upstream commit; Loom adds library policy, specialists, MCP, retrieval, memory, permission, and a process sandbox without modifying upstream source.

- **Multi-agent.** The chat agent plans and transforms files (`read` / `edit` / `write` / `bash`, FFmpeg). `run_retrieve_agent` searches and inspects the library. `run_create_agent` calls MCP servers such as ComfyUI and writes results back into the library. Each specialist call is a persistent task-owned conversation and one self-contained goal. Independent calls in the same turn run together. A specialist cannot start another specialist. The parent receives a summary; child tool cards stay in that turn. Stop and the permission gate apply to the child.
- **RAG.** `search_assets` fuses full-text rank and child-chunk vectors with RRF (`k = 60`). An optional rerank endpoint reorders those passages. Property filters are a hard AND. A hit is a passage plus a stable `asset_id`, so rename and move keep the same identity. A child hit can expand to its parent chunk (about 2048 tokens). Markdown is split on structure, then on 512-token windows with 64-token overlap. Images, video, and audio are written up to text and join the same index. Embeddings and VLM run only when the user or the agent asks.
- **Asset graph.** LadybugDB stores directed edges on `asset_id`, such as `derived from`. The agent records provenance with `create_relation`. `inspect_asset` returns neighboring edges. Retrieval that walks those edges (graph RAG) is the next step.
- **Context engineering.** A file placed in the composer is an `<asset_ref>` block in the stored message. The library highlight is folded before submit as `<ui_selection>` inside one `<system-reminder>` and persisted unchanged, with separate display text. Changing selection never rewrites earlier messages. Memory stays frozen per conversation; the skill catalog reloads during request preparation. Skills are a catalog of name, description, and path under `.agents/skills/`; the model reads `SKILL.md` when it needs the procedure.
- **Memory.** Each library has its own `.agents/memory/MEMORY.md` (about 2,000 characters) for preferences and conventions. `auto_memory` adds, replaces, or removes an entry and writes the file immediately. The running session keeps the snapshot it loaded at the start. Procedures stay in skills. Retrieve and create specialists do not receive this tool.
- **Sandbox.** Chat permission is Basic, Standard (default), or Full. With the process sandbox on (the default), `bash`, `ffmpeg`, and `ffprobe` may write only the open library and the temp directory, cannot read the user profile, and have no network. Full permission runs those processes directly. MCP servers stay outside this sandbox.
- **MCP.** Creation servers attach over MCP, over local stdio or remote HTTP. Their tools register as `server__tool` on the create specialist. The chat agent does not call them directly. Settings keeps that list. ComfyUI is one server. When a server writes a file outside the library, `write` or `bash` copies it in, and the watcher indexes it.

## Development

```bash
pnpm install                          # downloads ffmpeg and ffprobe; on Windows, installs the sandbox once
pnpm vendor:ffmpeg --all              # win32-x64, darwin-arm64, and darwin-x64
pnpm dev                              # Electron app (requires DEEPSEEK_API_KEY in .env)
pnpm --filter @loom/app check:node-sqlite  # Verify SQLite in the real Electron main process
pnpm --filter @loom/agent try:durable  # Live model/tool + temporary SQLite/reopen smoke test
pnpm test                             # All unit and integration tests
pnpm test:e2e                         # Playwright launch (needs app build)
pnpm test:e2e:attach                  # Playwright attach to pnpm dev (:9344)
pnpm -r typecheck
```

## Vendored pi durable engine

Loom vendors pi's [`packages/durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) and `packages/codemode` from upstream `main` into `packages/agent/vendor-pi-durable/` and `vendor-pi-codemode/`. Both are synced from the same commit. `src/durable-adapter.ts` is the vendor import boundary; `src/durable.ts` exposes `@loom/agent/durable`. It includes `LibraryAgent` (one Harness/Registry per library) and committed title/archive metadata; forks append `（分支）` and start unarchived. Loom Chat and the SQLite smoke chain work; `createLibraryExtension` now assembles durable coding/Loom/auto-memory tools and prompt sections, with frozen per-conversation memory. The root facade and app now use durable handles/events with document-based permission waits. Specialists use owned foreground conversations. Skills and tests/evals now use durable; specialist approve/reject/Stop/reopen and parallel execution are covered. Electron tests verify child approvals, reload/fork, and text visible before completion, including a real DeepSeek run. Workspace typechecks/tests pass. Strict live tool gold is 3/4; Approval-blocked SIGKILL/restart recovery passes; Windows runtime and further crash-point coverage remain pending. See [MIGRATION](./docs/agent/MIGRATION.md).

### Syncing upstream

`vendor-clean` holds pristine upstream source. Sync there, commit, then merge into Loom's `main`:

```bash
git checkout vendor-clean
pnpm vendor:sync                       # latest upstream main; optional ref argument
git add packages/agent/vendor-pi-durable packages/agent/vendor-pi-codemode
git commit -m "vendor: sync pi-durable main"
git checkout main
git merge vendor-clean
```

`vendor-pi-durable/sync.mjs` shallow-clones upstream and records `repo/directory/ref/commit` in `UPSTREAM`, without timestamps. On macOS it mirrors with `rsync --delete --delete-excluded`; native Windows uses an equivalent Node filesystem mirror. Tests, `testing/`, and benchmarks are excluded. `sync.sh` delegates to the same script. The script refuses to run outside `vendor-clean`.

Keep Loom-owned code outside both vendor `src/` directories: syncing deletes local additions there. The codemode directory is a private workspace package preserving upstream's package name and exports, so durable source stays unmodified; only `quickjs-wasi` is fetched from npm for it. A second sync of the same commit is a content no-op. npm dependencies remain separate and must be checked against upstream whenever syncing `main`.

### Isolated vendor checks

```bash
pnpm --filter @loom/agent typecheck:vendor
pnpm --filter @loom/agent test:vendor
pnpm --filter @loom/agent build:vendor       # builds codemode, then durable
pnpm --filter @loom/agent test:vendor:build  # checks compiled JS and worker
```

Source tests run without a build. Compiled checks select codemode's JS exports with `--conditions=loom-vendor-build`; the source exports remain the default for development. The old Loom tests, evals, and app cannot run until their harness imports are migrated.
