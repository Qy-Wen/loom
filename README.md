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

Extended from [pi agent core](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core`). Its agent loop is vendored in source, and Loom adds multi-agent roles, MCP, library retrieval, memory, permission, and a process sandbox on top. Creation tools attach over MCP.

- **Multi-agent.** The chat agent plans and transforms files (`read` / `edit` / `write` / `bash`, FFmpeg). `run_retrieve_agent` searches and inspects the library. `run_create_agent` calls MCP servers such as ComfyUI and writes results back into the library. Each specialist call is a fresh in-memory transcript and one goal. Independent calls in the same turn run together. A specialist cannot start another specialist. The parent receives a summary; child tool cards stay in that turn. Stop and the permission gate apply to the child.
- **RAG.** `search_assets` fuses full-text rank and child-chunk vectors with RRF (`k = 60`). An optional rerank endpoint reorders those passages. Property filters are a hard AND. A hit is a passage plus a stable `asset_id`, so rename and move keep the same identity. A child hit can expand to its parent chunk (about 2048 tokens). Markdown is split on structure, then on 512-token windows with 64-token overlap. Images, video, and audio are written up to text and join the same index. Embeddings and VLM run only when the user or the agent asks.
- **Asset graph.** LadybugDB stores directed edges on `asset_id`, such as `derived from`. The agent records provenance with `create_relation`. `inspect_asset` returns neighboring edges. Retrieval that walks those edges (graph RAG) is the next step.
- **Context engineering.** A file placed in the composer is an `<asset_ref>` block in the stored message. The library highlight stays out of history and is folded in at request time as `<ui_selection>` inside one `<system-reminder>`, so a changing selection does not rewrite the transcript or break the prompt prefix. The system prompt, skill catalog, and memory snapshot stay fixed for the session. Skills are a catalog of name, description, and path under `.agents/skills/`; the model reads `SKILL.md` when it needs the procedure.
- **Memory.** Each library has its own `.agents/memory/MEMORY.md` (about 2,000 characters) for preferences and conventions. `auto_memory` adds, replaces, or removes an entry and writes the file immediately. The running session keeps the snapshot it loaded at the start. Procedures stay in skills. Retrieve and create specialists do not receive this tool.
- **Sandbox.** Chat permission is Basic, Standard (default), or Full. With the process sandbox on (the default), `bash`, `ffmpeg`, and `ffprobe` may write only the open library and the temp directory, cannot read the user profile, and have no network. Full permission runs those processes directly. MCP servers stay outside this sandbox.
- **MCP.** Creation servers attach over MCP, over local stdio or remote HTTP. Their tools register as `server__tool` on the create specialist. The chat agent does not call them directly. Settings keeps that list. ComfyUI is one server. When a server writes a file outside the library, `write` or `bash` copies it in, and the watcher indexes it.

## Development

```bash
pnpm install                          # also downloads ffmpeg and ffprobe for this machine
pnpm vendor:ffmpeg --all              # win32-x64, darwin-arm64, and darwin-x64
pnpm dev                              # Electron app (requires DEEPSEEK_API_KEY in .env)
pnpm --filter @loom/agent try:agent   # Smoke test: run one agent loop
pnpm test                             # All unit and integration tests
pnpm test:e2e                         # Playwright launch (needs app build)
pnpm test:e2e:attach                  # Playwright attach to pnpm dev (:9344)
pnpm -r typecheck
```

## Vendored pi agent engine

Loom vendors the source of pi's [`packages/agent`](https://github.com/earendil-works/pi) into `packages/agent/vendor-pi-agent/`. Application code accesses it only through `packages/agent/src/pi-adapter.ts`, the sole `#vendor/pi-agent` import boundary.

### Syncing and upgrading upstream

**Mental model:** the `vendor-clean` branch always represents pristine upstream source. `main` obtains vendor updates by merging that branch, and all local modifications live only on `main`.

The sync script at `packages/agent/vendor-pi-agent/sync.sh` shallow-clones a ref from GitHub, mirrors `packages/agent/src/` with `rsync --delete`, and records the repository, directory, ref, and commit in `UPSTREAM`. It does not require a local pi checkout and is idempotent for the same version.

```bash
# Initially create a normal branch from a commit containing the pristine vendor source.
git branch vendor-clean

# Fixed four-step upgrade flow:
git checkout vendor-clean
pnpm --filter @loom/agent vendor:sync v0.86.0
git commit -am "vendor: update pi-agent to v0.86.0 (pristine)"
git checkout main
git merge vendor-clean
```

**Two constraints:**

1. Syncing mirrors with `rsync --delete`; it does not merge. Run it **only on `vendor-clean`**.
2. Modify vendor source only on `main`. Put Loom-owned additions in `packages/agent/src/`, not inside `vendor-pi-agent/src/`, where the next sync would delete them.

**External dependencies:** the vendored agent requires `@earendil-works/{pi-ai,chord,pi-telemetry}` plus `diff`, `ignore`, `typebox`, and `yaml`. They remain npm dependencies of `@loom/agent` and must match the pi version recorded in `UPSTREAM`.
