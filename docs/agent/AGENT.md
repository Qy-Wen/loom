**English** | [简体中文](./AGENT.zh-CN.md)

# Agent Architecture

> This document records how Loom's Agent layer is implemented: source boundaries, decoupling, upstream merges, user-message attachments, and the frontend interaction protocol (AG-UI).
> See [PRODUCT.md](./PRODUCT.md) Sections 6–7 for product positioning, [Pi Harness integration scope](./PI-HARNESS.md) for the runtime boundary, [EVALS.md](./EVALS.md) for how Agent and retrieval are scored, and [TODO.md](./TODO.md) for the roadmap.

---

## 1. Goal and positioning

- Loom's Agent is a **creative-asset Agent** with pi's workspace tools (`read` / `edit` / `write` / `bash`) plus library tools (`search_assets`, `ffmpeg.*`, MCP). Skills load from the open library's `.agents/skills/`. Multi-agent and a process sandbox are deferred; see [TODO](./TODO.md).
- Library retrieval is RAG: Hybrid Search returns text passages (images and video are written up first, then chunked) and the Agent answers or acts from those chunks, not from stuffing the whole library into the prompt. See [RAG](./RAG/RAG.md).
- One goal is to develop hands-on Agent engineering expertise, so Loom vendors and selectively modifies the agent loop source instead of treating it as a black-box SDK.
- Only the true core is vendored. Infrastructure such as model and provider integrations remains in published npm packages to avoid burying the project in unrelated code.

---

## 2. Source boundary: vendor only `packages/agent`, use npm for the rest

> **The vendored source is pi's `packages/agent` package (published as `@earendil-works/pi-agent-core`), the agent-loop kernel.**
> It is **not `packages/coding-agent`**, which is an application shell for terminal coding workflows (SessionManager, ResourceLoader, InteractiveMode, CLI, skill loading, and more) and is tightly coupled to TUI/CLI concerns Loom does not need.

Pi's Agent-related code has three layers, handled differently by Loom:

| Layer | pi package | Size | Loom approach | Reason |
|---|---|---:|---|---|
| Agent-loop kernel | `packages/agent` (`pi-agent-core`): `agent.ts`, `agent-loop.ts`, execution, compaction | A few thousand core lines | **Vendor source** | This is the primary area to study and modify |
| Model/provider integration | `pi-ai` (`packages/ai`) | ~24k lines; 73% provider adapters | **npm dependency** for now | Integrating 40+ vendors is infrastructure, not Loom's Agent capability |
| Event flow/telemetry | `chord`, `pi-telemetry` | — | **npm dependencies** | Runtime foundations; telemetry can receive a NOOP implementation |

`pi-ai` is not vendored because it is large, mostly provider glue, and brings heavyweight SDKs such as `@anthropic-ai/sdk`, `openai`, `@google/genai`, and `@aws-sdk/*`.

**Model seam:** `HarnessSessionManager` builds the selected Chat model with `pi-ai` and passes it to `AgentHarness` lanes. Loom configures OpenAI-compatible Chat requests without vendoring `pi-ai`; see [Pi Harness integration scope](./PI-HARNESS.md).

---

## 3. Vendor strategy: sync script and pristine branch

> A sync script copies upstream source into `vendor-pi-agent/`. A pristine branch isolates upstream, and normal three-way Git merges carry updates into Loom.
> Submodule and subtree are avoided because both are awkward for selecting one subdirectory and then modifying it freely.

### 3.1 Layout

The vendor directory lives directly inside `@loom/agent`, allowing it to resolve pi's external dependencies from the same package:

```
packages/agent/                 # @loom/agent
├── package.json                # imports: "#vendor/pi-agent" → ./vendor-pi-agent/src/index.ts
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts                # Loom-owned tools, events, and settings
│   ├── harness-session-manager.ts # Harness session/runtime owner
│   ├── pi-adapter.ts           # pi-ai Chat model and attachment conversion
│   └── pi-tools.ts             # native workspace tools and Loom tool bridge
├── scripts/try-agent.ts        # smoke test
└── vendor-pi-agent/
    ├── UPSTREAM                # source repository, commit, and tag
    ├── src/                    # copied pi source, available for modification
    └── sync.sh                 # sync script
```

### 3.2 `vendor-pi-agent/sync.sh`

The script shallow-clones a requested GitHub ref into a temporary directory, copies `packages/agent/src/` while excluding tests, testing helpers, and benchmarks, records the upstream commit in `UPSTREAM`, and removes the temporary directory. The default ref is `v0.85.1`.

**Why fetch remotely instead of reading a local pi checkout:** the workflow is self-contained. Anyone can clone Loom and sync without already having pi on disk, and the script never changes a developer's local pi branch state.

```bash
set -euo pipefail
REF="${1:-v0.85.1}"
REPO="https://github.com/earendil-works/pi.git"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$REF" --quiet "$REPO" "$TMP"
UPSTREAM_SHA="$(git -C "$TMP" rev-parse HEAD)"

rsync -a --delete \
  --exclude='**/*.test.ts' \
  --exclude='**/testing/**' \
  --exclude='benchmark/**' \
  "$TMP/packages/agent/src/" "$HERE/src/"

# UPSTREAM records repo / directory / ref / commit
```

Run `pnpm --filter @loom/agent vendor:sync [ref]`, or use `pnpm vendor:sync` from the repository root. No local pi path is required.

### 3.3 One workflow for initial import and upgrades

**Single mental model: `vendor-clean` always contains pristine upstream source, and `main` always receives vendor changes through `git merge`.** The same path applies to the initial import and every upgrade, regardless of whether the vendor source has been modified locally.

```bash
VENDOR=packages/agent/vendor-pi-agent

# Initially branch from a normal commit that already contains pristine source.
git branch vendor-clean

# Every future upgrade follows these four steps:
git checkout vendor-clean
$VENDOR/sync.sh v0.86.0
git commit -am "vendor: update pi-agent to v0.86.0 (pristine)"
git checkout main
git merge vendor-clean
```

This works because `vendor-clean` remains pure upstream while `main` carries local changes. Git automatically merges non-conflicting upstream updates and stops only where Loom genuinely modified the same code. A normal branch is preferred to an orphan branch because it retains a shared ancestor and a natural history.

**Two critical constraints:**

1. **Sync means an `rsync --delete` mirror, not a merge.** It adds and overwrites upstream files and removes files deleted upstream. It knows nothing about Loom's modifications; Git performs the real three-way merge. Run sync **only on `vendor-clean`**.
2. **Modify vendor code only on `main`; keep `vendor-clean` pristine.** Put Loom-owned additions in `packages/agent/src/`, not `vendor-pi-agent/src/`, where a future sync would remove them.

### 3.4 External dependency alignment

The vendored Agent still requires chord, pi-ai, pi-telemetry, diff, ignore, typebox, and yaml. They are npm dependencies of `@loom/agent` and must match the pi version recorded in `UPSTREAM` (pi packages share a release version such as 0.85.1). Upgrade them together with the vendor source.

---

## 4. Decoupling through the Loom Agent boundary

> Core rule: **the rest of Loom never imports `#vendor/pi-agent`; it uses the Loom-owned `HarnessSessionManager` and tool/event types from `@loom/agent`.**

```
Loom application code → @loom/agent
                       ├── types.ts                 # Loom tools, events, settings
                       ├── harness-session-manager.ts # session and AgentHarness owner
                       ├── library-skills.ts        # Agent Skills from the open library
                       ├── pi-adapter.ts            # pi-ai Chat model and message folding
                       └── pi-tools.ts              # native tools and Loom tool bridge
                                        ↓
                                 vendor-pi-agent/
```

Only `harness-session-manager.ts`, `library-skills.ts`, `pi-adapter.ts`, and `pi-tools.ts` import `#vendor/pi-agent`; the application uses their exported Loom surface. Node's native `imports` field maps `#vendor/pi-agent` and `#vendor/pi-agent/node` into `vendor-pi-agent/`, with matching tsconfig paths.

### Registering tools without changing upstream

- **Workspace tools:** use Pi Harness's native `createReadTool` / `createEditTool` / `createWriteTool` / `createBashTool` with `NodeExecutionEnv`. `cwd` is the open library; relative and absolute paths both work. `read` attaches JPEG, PNG, GIF, and WebP for the model, scaling anything over 2000px or about 4.5MB of base64. BMP and other decodable images are converted to PNG first.
- **Library tools:** `search_assets`, `inspect_asset`, `ffmpeg.*`, and later `create_relationship`. `search_assets` is the retrieve step of RAG: RRF over FTS and child-chunk vectors, returning passage + `asset_id`.
- **MCP client:** Main loads app user-data `mcp.json` (or `LOOM_MCP_CONFIG`) and registers those tools as `server__tool`. Settings → MCP edits that list. Any MCP server can attach; ComfyUI is one example.
- **System prompt:** the open library root is the working directory. It stays stable across turns. Live UI selection is not written here.
- **Skills:** on library open, scan `<library>/.agents/skills/` for Agent Skills (`SKILL.md`). The system prompt gets the name / description / location catalog. The model uses `read` for the body and any relative files. Loom does not create that folder, scan the rest of the library, or add skill slash-commands. Do not vendor `packages/coding-agent`.

---

## 5. User message attachments

> Transcript contract for system-injected context (UI selection first). Chat bubbles show `content` only. Prefix cache requires the folded Chat `content` for a stored user message to be identical on every later request.

Do not put changing UI state in the system prompt (that busts the entire prefix). Do not add a `get_selection` tool. Do not persist the fold inside `content` and then strip it for display.

### 5.1 Stored user message

Harness's persisted user message keeps a sidecar field. After send, that user row is frozen.

```json
{
  "role": "user",
  "timestamp": 1727000000000,
  "content": [{ "type": "text", "text": "把这个处理一下" }],
  "attachments": [
    {
      "type": "ui_selection",
      "assetId": "a1b2c3d4-…",
      "path": "clips/hero.mp4",
      "assetType": "video"
    }
  ]
}
```

When nothing is selected and the composer has no chips, omit `attachments`. Do not store a `none` placeholder.

Snapshot at send time from the current library highlight (`assetId`, workspace-relative `path`, `assetType`) as one `ui_selection` row. Graph edges are not a selection. The composer can also attach library files explicitly: drag one from the library onto the input, right-click a file and choose Add to chat, or use the + menu (Library file). External file and Finder drops copy into `Inbox/` first (or reuse the asset if the file is already in the library), then attach the same chip. Each chip is an `asset_ref` row, keyed by `assetId`, with a library-relative `path`. Same fields as `ui_selection`; different `type`. At send, look up the live library row by `assetId` and write the current `path` / `assetType`. Older rows stay frozen. Do not put timestamps or other per-request noise in the payload.

A chip sits in the text, including between words. `content` stores that position, and the fold writes the `<asset_ref>` block there. Older transcripts that stored chips as `ui_selection` still fold as `<ui_selection>`. An implicit library highlight that was not already in the chips is appended after the text as `<ui_selection>`. Titles read the words and skip the chip. A click on a chip selects that asset in the library.

### 5.2 Fold for the Chat API

Chat uses OpenAI-compatible `POST /v1/chat/completions`. Many servers accept only a single string `content`, not multiple text parts. `toProviderMessages` in `pi-adapter` folds each stored user message's text and attachments into **one string** before `convertToLlm`. Injections never become a second text part.

A composer picture that is already on a stored user row’s `content` still goes out as `image_url`. New attaches from the composer are library chips, not image parts. The agent reads pixels only if it calls `describe_image` / `describe_video` / `describe_audio` or `read`. If a historical image part is rejected, Loom shows that error and moves the active path back to before the message.

The fold is deterministic. The HTTP body never includes `attachments`.

```
把这个处理一下

<asset_ref>
path: clips/hero.mp4
asset_id: a1b2c3d4-…
type: video
</asset_ref>
```

A leftover library highlight uses the same three fields inside `<ui_selection>`. Empty: fold is the user text only. Do not append `<ui_selection>none</ui_selection>`.

System prompt gets one **fixed** sentence: a user message may include `<asset_ref>` blocks for library files placed in the message, and a `<ui_selection>` block for the file selected in the library when they sent it; use those blocks for “this” / “the file” when they do not name a path; if they name a different path, prefer that.

The next user turn snapshots the library highlight again. If it matches the most recent `ui_selection` already in the transcript (`assetId`), omit that attachment and the fold — history still has that block. A prior `asset_ref` of the same file does not suppress the next implicit `ui_selection`. If there is no prior `ui_selection`, or the file changed, attach and fold as usual. Older rows are not rewritten. Within one turn (tool loop), reuse the send-time snapshot. On the same send, skip the implicit `ui_selection` when that `assetId` is already among the chips.

---

## 6. Frontend protocol: CopilotKit and AG-UI, without exposing Pi runtime events

Pi Harness emits in-process runtime events; `HarnessSessionManager` exposes Loom's smaller `LoomAgentEvent` stream. Neither defines the frontend transport: `LoomAgUiAgent` translates Loom events into AG-UI over SSE.

### 6.1 Seam location

The frontend **temporarily uses CopilotKit** for a ready-made chat UI over AG-UI. CopilotKit requires an HTTP runtime endpoint, so Electron Main hosts it in a localhost HTTP server. This directly realizes PRODUCT.md Section 9, where Local Core may become a local service.

**CopilotKit is safe as a temporary choice because its three layers can evolve independently:**

| Layer | Content | When Loom becomes a deeper workbench |
|---|---|---|
| 1. Protocol/runtime | AG-UI transport and runtime endpoint | **Keep long term**; independent of UI |
| 2. React hooks | `useCopilotAction` for generative UI, `useCoAgent` for shared state, `useCopilotReadable` for exposing UI state | **Become more useful** in a workbench |
| 3. Ready-made UI | `CopilotChat` from `@copilotkit/react-core/v2` | Replace with Loom's own workbench UI while retaining layers 1 and 2 |

A richer workbench replaces only the chat component. The runtime and `LoomAgUiAgent` remain unchanged, while generative UI and shared state continue to use the hooks. Even abandoning CopilotKit entirely does not damage the backend because AG-UI remains the protocol boundary.

```
Renderer process
  @copilotkit/react-core/v2: CopilotKitProvider + CopilotChat
   │ HTTP / SSE, runtimeUrl = http://127.0.0.1:<port>/api/copilotkit
   ↓
Main process (Local Core)
┌────────────────────────────────────────────┐
│ localhost HTTP server                      │
│   └ CopilotKit runtime endpoint            │
│        └ LoomAgUiAgent (AG-UI seam)         │  LoomAgentEvent → AG-UI
│             └ HarnessSessionManager        │  @loom/agent
└────────────────────────────────────────────┘
   │ pi-ai
   ↓
Model (DeepSeek, ...)
```

Pi Harness events and `LoomAgentEvent` **never leave the Main process**. Only AG-UI is exposed externally. Extracting Local Core into a standalone localhost service or replacing pi with a custom Agent requires no frontend changes as long as AG-UI remains the output.

**Verified implementation details:**

- The seam extends `AbstractAgent` from `@ag-ui/client` and implements `run(input): Observable<BaseEvent>` with RxJS.
- `@ag-ui/{client,core}` is pinned to **1.0.1**, matching `@copilotkit/runtime` 1.77.0.
- The Node endpoint uses v2 `createCopilotNodeListener`, not the deprecated v1 endpoint.
- The frontend uses `CopilotKitProvider` and `CopilotChat` directly from `@copilotkit/react-core/v2`; `@copilotkit/react-ui` is unnecessary.
- Runtime clones the registered AG-UI agent for each run. `LoomAgUiAgent.clone()` keeps the shared `HarnessSessionManager` and in-flight run map.
- `HarnessSessionManager` owns session handles and persists new conversations in `<library>/.loom/harness-sessions/` via Pi `JsonlSessionRepo`; history reads the active path. Old v1 files in `<library>/.loom/sessions/` remain untouched. Branching from an earlier question is in §6.3d.

**Server rules:**

- `server.listen(0, "127.0.0.1")` chooses a free random port and binds only to localhost, avoiding port conflicts and external reachability.
- Preload/IPC injects the actual port into Renderer for `<CopilotKitProvider runtimeUrl>`.
- Main awaits the listener before creating the window and closes the server during `app.on("will-quit")`.

### 6.2 Event mapping

`LoomAgUiAgent` consumes Loom's reduced `LoomAgentEvent` set and translates it into AG-UI:

| `LoomAgentEvent` | AG-UI event |
|---|---|
| `agent_start` | `RUN_STARTED` |
| `text` delta | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` |
| `thinking_start` / `thinking_delta` / `thinking_end` | `REASONING_START`, `REASONING_MESSAGE_*`, `REASONING_END` |
| `tool_pending` | `TOOL_CALL_START` and `TOOL_CALL_ARGS` while the call waits for approval |
| `tool_start` | Same pair; skipped if `tool_pending` already started that `toolCallId` |
| `tool_progress` | `ACTIVITY_SNAPSHOT` `loom.tool_progress`, replaced in place; hidden when the call ends |
| `tool_end` | `TOOL_CALL_END` and `TOOL_CALL_RESULT`; structured `details` also emits `CUSTOM loom.tool_result` |
| `retry_scheduled` / `retry_start` / `retry_end` | `ACTIVITY_SNAPSHOT` `loom.retry`. The row shows the wait, then clears |
| `error` | A `loom-error-*` notice plus `RUN_ERROR` (bad key, unreachable Chat, missing Settings). Styled as a system alert, not a model reply. |
| `agent_end` | `RUN_FINISHED` |

### 6.3 Preserved behavior and deferred product capabilities

Harness provides the runtime; Loom maps existing behavior and defers only the listed product interactions.

**a. Thinking/reasoning**

- Pi `thinking_start` / `thinking_delta` / `thinking_end` become `LoomAgentEvent` of the same names, then AG-UI `REASONING_*`. Deprecated `THINKING_*` events do not create a chat message.
- Redacted thinking is dropped. `thinkingSignature` / `thoughtSignature` stay on the transcript and are not sent to the frontend.

**b. Rich tool output**

- Pi's `AgentToolResult` naturally has two channels: `content` (text for the model) and `details` (structured data for UI rendering).
- Loom now preserves both channels: text maps to `TOOL_CALL_RESULT`, while structured details emit `CUSTOM loom.tool_result`.
- `search_assets` and `inspect_asset` use `asset_list` and `asset_detail` detail payloads. The chat draws those files as links keyed by `asset_id`. A click selects the asset in the library and does not switch away from the Agent tab.

**c. Stop conversation**

- CopilotChat Stop detaches the AG-UI run and requests cancellation through `HarnessSessionManager.abort()`.
- Harness cancels the active operation; signals propagate to in-flight workspace/library/MCP tools, FFmpeg child processes, and model requests.
- Stop is recorded durably in the Harness session as a user cancellation, distinct from an error; it is not mapped as a Chat `RUN_ERROR`.
- Enter while a run is active queues the text as `followUp`. The same run continues when it would otherwise finish, one queued follow-up at a time. Queued text sits above the composer until it is inserted, then it leaves the queue and appears as a user message. Stop drops follow-ups that have not been inserted. `steer` and `nextRun` are unused.

**d. Branch from a previous question**

- Selecting an earlier user question edits that message in place. Sending switches the active path to just before that question. The old path stays in the tree.
- Fork copies the prefix before that question into a new session, prefixes the title with `Fork: `, and leaves the original session unchanged. Files already written are not reverted.

**e. Tool permission**

- Chat footer dropdown: **Basic**, **Standard** (default), **Full**. Stored in app userData `agent-permission.json`, not in the library.
- `basic` waits on `write` / `edit` / `bash`. `standard` waits on `write` / `edit`. `full` intercepts nothing, including in-flight waits (they continue). FFmpeg and MCP are not gated.
- Pi `before_tool` (hook id `loom.tool_permission`) emits `tool_pending` and pauses until Approve or Skip on that tool card. Stop aborts the wait. Evals set `full` so they cannot hang.

---

## 7. Evals

In-repo gold sets, stub Chat / fake embed for CI, `--live` against `.env` Chat and Embedding slots. Commands, metrics, and out-of-scope items: [EVALS.md](./EVALS.md).

---

## 8. Summary

- **One vendored package:** pi-agent, available for source-level study and modification.
- **Three npm packages:** pi-ai, chord, and pi-telemetry, aligned with `UPSTREAM`.
- **Upstream merges:** pristine `vendor-clean` branch plus normal three-way merges.
- **Decoupling:** application code uses `HarnessSessionManager` and Loom-owned event/tool types; only `@loom/agent` imports the vendored Pi Harness.
- **User attachments:** Library highlight (`ui_selection`) and composer chips (`asset_ref`) live on the user row as `attachments`, keyed by `assetId`. External files are copied into `Inbox/` first. `toProviderMessages` folds every attachment into one Chat text string. Historical image parts on `content` still send as `image_url`. Attachment chips and `search_assets` / `inspect_asset` refs select that asset in the library.
- **Frontend protocol:** CopilotKit/AG-UI over a localhost server in Main; `LoomAgUiAgent` translates `LoomAgentEvent` without leaking Pi runtime events.
- **Tool permission:** three levels in the chat footer. Default **Standard** confirms `write` / `edit`; **Full** intercepts no tools.
- **Evals:** compaction rate, prompt-cache hit rate, in-repo Agent/tool gold tasks, and retrieval Recall@k / nDCG. See [EVALS.md](./EVALS.md).
- **Current scope:** production chat and new-session persistence run through Harness; asset tools preserve stable call IDs and structured result payloads. Stop cancels the active operation; model thinking is shown in chat. Enter during a run queues a follow-up and continues that run when it would otherwise finish. Automatic threshold compaction is on. Branching from an earlier question is available. Composer library chips and clickable asset refs are on. Skills are the catalog in the system prompt; the model reads `SKILL.md` on demand. Write/edit (and optionally bash) wait for approval unless the session is on Full.
