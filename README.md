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

**Publishing.** Third-party MCP servers can extend social platform publishing through the main agent. Servers require separate installation, configuration, and login; platform compatibility depends on the server.

**Through conversation.** Search, the table, relations, image and video work, and creation are all available to the agent. Ask it to find an asset by what it shows or sounds like, change a column, draw a relation, use FFmpeg to crop, grade, transcode, or compress, or have ComfyUI make a new image. Place a library file in the composer, and it knows which one you mean.

## Agent

Built on [pi durable](https://github.com/earendil-works/pi/tree/main/packages/durable). Durable and codemode are vendored from the same upstream commit; Loom adds library policy, specialists, MCP, retrieval, memory, permission, and a process sandbox without modifying upstream source.

- **Multi-agent.** The chat agent plans, searches and inspects the library (`search_assets`, `deep_search_assets`, `inspect_asset`), transforms files (`read` / `edit` / `write` / `bash`, FFmpeg), and calls MCP tools directly. A single retrieval task, including a multi-step one, runs directly; `run_retrieve_agent` is considered only for multiple independent retrieval tasks that can run in parallel. `run_create_agent` shares the MCP tools and handles delegated creative workflows in a fresh context. Each specialist call is a persistent task-owned conversation and one self-contained goal. Independent calls in the same turn run together. A specialist cannot start another specialist. The parent receives a summary; child tool cards stay in that turn. Stop and the permission gate apply to the child.
- **RAG.** Two searches. `search_assets` is simple: file-level full text over names, properties, extracts, and captions, with no model and no index. `deep_search_assets` searches indexed chunks, fusing chunk full text and child-chunk vectors with RRF (`k = 60`); an optional rerank endpoint reorders those passages. Chinese is segmented into words so a word inside a sentence matches. Property filters are a hard AND. A hit is a passage plus a stable `asset_id`, so rename and move keep the same identity. A child hit can expand to its parent chunk (about 2048 tokens). Markdown is split on structure, then on 512-token windows with 64-token overlap. Images, video, and audio are written up to text and join the same index. Embeddings and VLM run only when the user or the agent asks.
- **Asset graph.** LadybugDB stores directed edges on `asset_id`, such as `derived from`. The agent records provenance with `create_relation`. `inspect_asset` returns neighboring edges. Search does not walk them; the Agent follows them with `inspect_asset`.
- **Context engineering.** A file placed in the composer is an `<asset_ref>` block in the stored message. The library highlight is folded before submit as `<ui_selection>` inside one `<system-reminder>` and persisted unchanged, with separate display text. Changing selection never rewrites earlier messages. Memory stays frozen per conversation; the skill catalog reloads during request preparation. Skills are a catalog of name, description, and path under `.loom/agents/skills/`; the model reads `SKILL.md` when it needs the procedure.
- **Memory.** Each library has its own `.loom/agents/memory/MEMORY.md` (about 2,000 characters) for preferences and conventions. `auto_memory` adds, replaces, or removes an entry and writes the file immediately. The running session keeps the snapshot it loaded at the start. Procedures stay in skills. Retrieve and create specialists do not receive this tool.
- **Sandbox.** Chat permission is Basic, Standard (default), or Full. With the process sandbox on (the default), `bash`, `ffmpeg`, and `ffprobe` may write only the open library and the temp directory, cannot read the user profile, and have no network. Full permission runs those processes directly. MCP servers stay outside this sandbox.
- **MCP.** Supports local stdio and Streamable HTTP. Settings manages connected servers. Tools register as `server__tool` and are shared by the main agent and create specialist. The main agent chooses direct execution or delegation; the retrieve specialist has no MCP tools. Basic and Standard require approval for MCP calls from either agent, with per-tool remembered grants; Full runs them directly. When a server writes a file outside the library, `write` or `bash` copies it in, and the watcher indexes it.

## Package boundaries

- `core` owns library files and stable asset IDs, metadata and relations, retrieval, and media processing. `LocalCore` is the domain facade; storage and internal services are private. The root entry exports the facade, domain types, provider contracts, and shared path/binary helpers. Grading helpers and process sandboxing use `@loom/core/grade` and `@loom/core/sandbox`.
- `agent` owns the library-scoped conversation runtime and agent policies. It depends on `core`.
- `app` owns Electron, UI, IPC, settings and credentials, HTTP providers, MCP connections, and chat/tool integration. It calls `LocalCore` and injects provider implementations through core contracts. It does not access core stores directly.

These are code boundaries: core capabilities and the agent runtime currently run in the Electron main process.

Source files follow feature ownership:

- `agent/src`: `runtime`, `models`, `context`, `extensions`, `tools`, and `trace`; public facades, the vendor import boundary, and package-wide contracts stay at the root.
- `app/src/main`: `desktop`, `chat`, `composer`, `models`, `settings`, `tools`, and `mcp`. Storage stays with its feature.
- `app/src/renderer`: chat and asset details live in `chat` and `details`; shared UI controls live in `components`. `app/src/shared` holds cross-process contracts and pure helpers; `preload` bridges typed IPC.

## Website

The bilingual introduction page lives in [`website/`](./website/README.md). Run `npm run website:dev` to preview, `npm run website:build` for static output, or `npm run website:deploy` to publish using your local server configuration. No additional dependencies are required. Download links are configured separately from publishing credentials.

## Development

For the full Mac build → COS and GitHub → website workflow, see [releasing](./docs/RELEASING.md).

```bash
pnpm install                          # downloads ffmpeg and ffprobe; on Windows, installs the sandbox once
pnpm vendor:ffmpeg --all              # win32-x64, darwin-arm64, and darwin-x64
pnpm dev                              # Electron app (requires DEEPSEEK_API_KEY in .env)
pnpm dist                             # On a Mac: macOS arm64/x64 dmg and the Windows x64 installer
pnpm --filter @loom/app check:node-sqlite  # Verify SQLite in the real Electron main process
pnpm --filter @loom/agent try:durable  # Live model/tool + temporary SQLite/reopen smoke test
pnpm test                             # All unit and integration tests
pnpm --filter @loom/app build:e2e     # Build for e2e into out-e2e/ (pnpm dev keeps out/, so both can run together)
pnpm test:e2e                         # Playwright launch (needs build:e2e)
pnpm test:e2e e2e/x.spec.ts -g "name" --repeat-each=20   # one spec or case, repeated; --last-failed reruns failures
pnpm test:e2e:attach                  # Playwright attach to pnpm dev (:9344)
pnpm -r typecheck
```

## Vendored pi durable engine

Loom vendors pi's [`packages/durable`](https://github.com/earendil-works/pi/tree/v1.4.0/packages/durable) and `packages/codemode` from upstream `v1.4.0` (`4a080252`) into `packages/agent/vendor-pi-durable/` and `vendor-pi-codemode/`. Loom-owned code stays outside vendor `src/`; `src/durable-adapter.ts` is the import boundary. `@loom/agent` assembles one SQLite Harness/Registry per library, document-based metadata/approval/memory, skills sections, and foreground owned specialists. App chat uses native durable events and fork-aware full history, independently of model compaction; forks append `（分支）` and start unarchived.

The pi-ai, Chord, telemetry, and vendored codemode versions are aligned at `1.4.0`. Opening an existing library automatically migrates durable SQLite schema v1 to v2 for sleeping tasks; older durable versions cannot reopen the migrated database. If rollback is needed, close Loom and back up the library's `.loom/` directory before first opening it with this version.

Workspace typechecks and vendor checks pass; the Windows settings-persistence concurrency test currently fails with `rename EPERM`. Electron accepts post-compaction reload/fork, pre-completion streaming (including real DeepSeek), and SIGKILL recovery during approval, streaming, and unsafe bash execution. Strict live tool gold passed 4/4 twice without relaxing expectations. Development traces persist locally in `.loom/agents/traces/telemetry.sqlite` ([TRACE](./docs/agent/TRACE.md)). Windows on-device validation and controlled old/new eval comparisons remain.

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

Typechecking follows Loom's entry points and their imports; the vendor build starts from the Node entry points. Unused platform adapters such as IndexedDB are outside these compilation roots. Source tests run without a build. Compiled checks select codemode's JS exports with `--conditions=loom-vendor-build`; the source exports remain the default for development. The old Loom tests, evals, and app cannot run until their harness imports are migrated.
