**English** | [简体中文](./DEVELOPMENT.zh-CN.md)

# Development

For prerequisites and startup, see the [quick start](../README.md#quick-start).

## Package boundaries

- `packages/core` owns library files and stable asset IDs, metadata, relations, retrieval, and media processing. `LocalCore` is the domain facade; stores and internal services stay private. The root entry exports domain types, provider contracts, and shared path/binary helpers. Grading and process sandboxing use `@loom/core/grade` and `@loom/core/sandbox`.
- `packages/agent` owns the library-scoped conversation runtime and agent policies. It depends on `core`.
- `packages/app` owns Electron, UI, IPC, settings, credentials, HTTP providers, MCP connections, and chat/tool integration. It calls `LocalCore` and injects providers through core contracts, without accessing core stores directly.

Core capabilities and the agent runtime run in the Electron main process. Source follows feature ownership:

- `agent/src`: `runtime`, `models`, `context`, `extensions`, `tools`, and `trace`. Public facades, the vendor boundary, and package-wide contracts stay at the root.
- `app/src/main`: `desktop`, `chat`, `composer`, `models`, `settings`, `tools`, and `mcp`. Storage stays with its feature.
- `app/src/renderer`: all visual values come from `design/tokens.css` (see the [design system](./DESIGN.md)); chat and asset details live in `chat` and `details`; shared UI controls live in `components`. `app/src/shared` holds cross-process contracts and pure helpers; `preload` bridges typed IPC.

## Checks

Run from the repository root:

```sh
pnpm test
pnpm -r typecheck
node --test scripts/release.test.mjs website/scripts/deploy.test.mjs
pnpm --filter @loom/app check:node-sqlite
pnpm --filter @loom/app check:chat-platform
```

`pnpm test` runs workspace package tests. Release/deployment tests run separately. The Electron checks need a local Electron installation; the chat-platform check also needs OS credential encryption.

End-to-end tests build into `out-e2e/`, separate from the development app's `out/`:

```sh
pnpm --filter @loom/app build:e2e
pnpm test:e2e
pnpm test:e2e e2e/x.spec.ts -g "name" --repeat-each=20
pnpm test:e2e:attach
```

Replace `e2e/x.spec.ts` and `name` with a real test. `--last-failed` reruns failures. The attach command connects to a running `pnpm dev` at port 9344.

The live model/tool and SQLite reopen smoke test is `pnpm --filter @loom/agent try:durable`. It needs a root `.env` with `LOOM_CHAT_API_KEY` or `DEEPSEEK_API_KEY` and calls the configured model service.

## Build and publish

`pnpm dist` runs on a Mac and builds macOS arm64/x64 DMGs and a Windows x64 installer. It downloads FFmpeg for all three targets before building; `pnpm vendor:ffmpeg --all` can also prepare those binaries separately.

For versioned builds, COS/GitHub uploads, and website updates, follow [releasing](./RELEASING.md). Website preview and server deployment are documented in [`website/README.md`](../website/README.md).

## Vendored pi engine

Loom vendors pi durable and codemode from upstream `v1.5.1` (`dd30101c`). Each vendor directory records its source in `UPSTREAM`. The pi-ai, pi-schema, Chord, telemetry, and codemode versions are aligned at `1.5.1`. `packages/agent/src/durable-adapter.ts` is the import boundary; Loom-owned code stays outside vendor `src/`.

Opening an existing library migrates durable SQLite schema v1 to v2 for sleeping tasks. Older durable versions cannot open the migrated database. To preserve rollback, close Loom and back up the library's `.loom/` directory before opening it with the newer version.

Conversation and task documents also migrate; older engines cannot read all upgraded state. The chat bridge uses native `Conversation.watch()` and `ConversationTranscript`; live progress displays immediately and persists within 1 second by default. pi-schema validates tool schemas and accepts existing TypeBox definitions.

### Sync upstream

`vendor-clean` holds pristine upstream source. Sync there, commit, then merge into your working branch:

```sh
git switch vendor-clean
pnpm vendor:sync
git add packages/agent/vendor-pi-durable packages/agent/vendor-pi-codemode
git commit -m "vendor: sync pi-durable main"
git switch main
git merge vendor-clean
```

`pnpm vendor:sync` defaults to upstream `main` and accepts an optional ref. The script refuses to run outside `vendor-clean`. It mirrors upstream source with `rsync` on macOS and Node filesystem operations on Windows, excluding tests, `testing/`, and benchmarks. Local additions in vendor `src/` are deleted during sync. Repeating a sync of the same commit leaves content unchanged.

Codemode is a private workspace package preserving its upstream name and exports. Its `quickjs-wasi` dependency comes from npm. Check external dependency compatibility whenever syncing upstream.

### Vendor checks

```sh
pnpm --filter @loom/agent typecheck:vendor
pnpm --filter @loom/agent test:vendor
pnpm --filter @loom/agent build:vendor
pnpm --filter @loom/agent test:vendor:build
```

Source tests need no build. The vendor build starts from Node entry points and builds codemode before durable. Compiled checks select codemode's JS exports with `--conditions=loom-vendor-build`; development uses source exports.
