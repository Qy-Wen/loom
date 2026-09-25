**English** | [简体中文](./AGENT.zh-CN.md)

# Agent Architecture

> This document records how Loom's Agent layer is implemented: source boundaries, decoupling, upstream merges, user-message attachments, and the frontend interaction protocol (AG-UI).
> See [PRODUCT.md](./PRODUCT.md) Sections 6–7 for product positioning and [TODO.md](./TODO.md) for the roadmap.

---

## 1. Goal and positioning

- Loom's Agent is a **creative-asset Agent** with pi's workspace tools (`read` / `edit` / `write` / `bash`) plus library tools (`search_assets`, `ffmpeg.*`, MCP). Path jail and a process sandbox are deferred.
- Library retrieval is RAG: Hybrid Search returns text passages (later image/video hits) and the Agent answers or acts from those chunks, not from stuffing the whole library into the prompt. See [RAG](./RAG/RAG.md).
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

**Key seam: `StreamFn`.** This is the only runtime coupling between the Agent and AI layers. The agent loop calls the model through `streamFn`:

```typescript
const agent = new Agent({
  initialState: { systemPrompt, model },
  streamFn: models.streamSimple.bind(models), // sole Agent ↔ AI seam
});
```

`pi-ai` can therefore be replaced later. Deeper model work would require vendoring only `pi-ai/api` and one provider rather than importing the whole package today.

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
│   ├── types.ts                # stable LoomAgent interface used by application code
│   └── pi-adapter.ts           # only module importing #vendor/pi-agent
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

## 4. Decoupling through one adapter boundary

> Core rule: **the rest of Loom never imports `#vendor/pi-agent`; it imports Loom's adapter and types.**

```
Loom application code
      │  depends only on Loom interfaces (packages/agent/src/types.ts)
      ↓
packages/agent/src/
  ├── types.ts        # LoomAgent: prompt, subscribe, and related contracts
  └── pi-adapter.ts   # only #vendor/pi-agent import; translates pi ↔ Loom
        │
        ↓
   vendor-pi-agent/   # upstream source plus local modifications
```

Enforced constraints:

1. **Vendor boundary:** only `pi-adapter.ts` and `pi-tools.ts` may import `#vendor/pi-agent`. ESLint `no-restricted-imports` can enforce this later.
2. **Loom owns its interfaces:** `types.ts` defines `LoomAgent`; the adapter translates that API into pi. Replacing pi changes only the adapter.
3. **Import mechanism:** Node's native `imports` field maps `#vendor/pi-agent` and `#vendor/pi-agent/node` into `vendor-pi-agent/`, with matching tsconfig paths.

### Registering tools without changing upstream

- **Workspace tools:** wrap pi's `createReadTool` / `createEditTool` / `createWriteTool` / `createBashTool` with `NodeExecutionEnv`. `cwd` is the open library; relative and absolute paths both work.
- **Library tools:** `search_assets`, `inspect_asset`, `ffmpeg.*`, and later `create_relationship`. `search_assets` is the retrieve step of RAG; it will grow from FTS to chunk-level hybrid hits.
- **MCP client:** Main loads `mcp.json` (or `LOOM_MCP_CONFIG`) and registers those tools as `server__tool`. Creation runtimes such as ComfyUI attach here.
- **System prompt:** the open library root is the working directory. It stays stable across turns. Live UI selection is not written here.

---

## 5. User message attachments

> Transcript contract for system-injected context (UI selection first). Chat bubbles show `content` only. Prefix cache requires the folded Chat `content` for a stored user message to be identical on every later request.

Do not put changing UI state in the system prompt (that busts the entire prefix). Do not add a `get_selection` tool. Do not persist the fold inside `content` and then strip it for display.

### 5.1 Stored user message

JSONL / `state.messages` keep a sidecar field. After send, that user row is frozen.

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

When nothing is selected, omit `ui_selection` (omit `attachments` if it would be empty). Do not store a `none` placeholder.

Snapshot at send time from the current library selection (`assetId`, workspace-relative `path`, `assetType`). Graph edges are not a selection. `attachments` may grow later with other `type` values; do not put timestamps or other per-request noise in the payload.

Chat UI, titles, and `userMessageText` read `content` only.

### 5.2 Fold for the Chat API

Chat today is OpenAI-compatible `POST /v1/chat/completions`. Many servers accept only a single string `content`, not multiple text parts. `convertToLlm` in `pi-adapter` therefore joins the user text and every attachment into **one string**. Images stay as image parts on `content` if a later VLM turn needs them; injections never become a second text part.

The fold is deterministic. The HTTP body never includes `attachments`.

```
把这个处理一下

<ui_selection>
path: clips/hero.mp4
asset_id: a1b2c3d4-…
type: video
</ui_selection>
```

Empty selection: fold is the user text only. Do not append `<ui_selection>none</ui_selection>`.

System prompt gets one **fixed** sentence: a user message may include a `<ui_selection>` block for the file selected when they sent that message; use it for “this” / “the file” when they do not name a path; if they name a different path, prefer that.

The next user turn snapshots selection again. If it matches the most recent `ui_selection` already in the transcript (`assetId`), omit the attachment and the fold — history still has that block. If there is no prior `ui_selection`, or the file changed, attach and fold as usual. Older rows are not rewritten. Within one turn (tool loop), reuse the send-time snapshot.

---

## 6. Frontend protocol: CopilotKit and AG-UI, without exposing pi AgentEvent

Pi's “protocol” is only an **in-process TypeScript event stream**, the `AgentEvent` discriminated union exposed by `session.subscribe()`. It defines neither JSON nor transport. Changing frontend protocols means adding another consumer that subscribes to AgentEvent, translates it into AG-UI, and streams it to the frontend over SSE.

### 6.1 Seam location

The frontend **temporarily uses CopilotKit** for a ready-made chat UI over AG-UI. CopilotKit requires an HTTP runtime endpoint, so Electron Main hosts it in a localhost HTTP server. This directly realizes PRODUCT.md Section 9, where Local Core may become a local service.

**CopilotKit is safe as a temporary choice because its three layers can evolve independently:**

| Layer | Content | When Loom becomes a deeper workbench |
|---|---|---|
| 1. Protocol/runtime | AG-UI transport and runtime endpoint | **Keep long term**; independent of UI |
| 2. React hooks | `useCopilotAction` for generative UI, `useCoAgent` for shared state, `useCopilotReadable` for exposing UI state | **Become more useful** in a workbench |
| 3. Ready-made UI | `CopilotChat` from `@copilotkit/react-core/v2` | Replace with Loom's own workbench UI while retaining layers 1 and 2 |

A richer workbench replaces only the chat component. The runtime and AgUiAdapter remain unchanged, while generative UI and shared state continue to use the hooks. Even abandoning CopilotKit entirely does not damage the backend because AG-UI remains the protocol boundary.

```
Renderer process
  @copilotkit/react-core/v2: CopilotKitProvider + CopilotChat
   │ HTTP / SSE, runtimeUrl = http://127.0.0.1:<port>/api/copilotkit
   ↓
Main process (Local Core)
┌────────────────────────────────────────────┐
│ localhost HTTP server                      │
│   └ CopilotKit runtime endpoint            │
│        └ AgUiAdapter (Loom's sole seam)     │  LoomAgentEvent ↔ AG-UI
│             └ @loom/agent (pi agent loop)   │
└────────────────────────────────────────────┘
   │ streamFn
   ↓
Model (DeepSeek, ...)
```

`LoomAgentEvent` from `@loom/agent`, and therefore pi's `AgentEvent`, **never leaves the Main process**. Only AG-UI is exposed externally. Extracting Local Core into a standalone localhost service or replacing pi with a custom Agent requires no frontend changes as long as AG-UI remains the output.

**Verified implementation details:**

- The seam extends `AbstractAgent` from `@ag-ui/client` and implements `run(input): Observable<BaseEvent>` with RxJS.
- `@ag-ui/{client,core}` is pinned to **0.0.59**, matching `@copilotkit/runtime` 1.73.0.
- The Node endpoint uses v2 `createCopilotNodeListener`, not the deprecated v1 endpoint.
- The frontend uses `CopilotKitProvider` and `CopilotChat` directly from `@copilotkit/react-core/v2`; `@copilotkit/react-ui` is unnecessary.
- Runtime clones the registered Agent for each run. The adapter overrides `clone()` so its Agent configuration and thread session map survive cloning.
- Transcripts are append-only JSONL files in the current library `.loom/sessions/`. The adapter restores `initialMessages` the first time it sees a thread id and appends new messages after each run.

**Server rules:**

- `server.listen(0, "127.0.0.1")` chooses a free random port and binds only to localhost, avoiding port conflicts and external reachability.
- Preload/IPC injects the actual port into Renderer for `<CopilotKitProvider runtimeUrl>`.
- Main awaits the listener before creating the window and closes the server during `app.on("will-quit")`.

### 6.2 Event mapping

AgUiAdapter consumes Loom's reduced `LoomAgentEvent` set and translates it into AG-UI:

| `LoomAgentEvent` | AG-UI event |
|---|---|
| `agent_start` | `RUN_STARTED` |
| `text` delta | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` |
| `tool_start` | `TOOL_CALL_START` and `TOOL_CALL_ARGS`, preserving pi's stable `toolCallId` |
| `tool_end` | `TOOL_CALL_END` and `TOOL_CALL_RESULT`; structured `details` also emits `CUSTOM loom.tool_result` |
| `error` | A `loom-error-*` notice plus `RUN_ERROR` (bad key, unreachable Chat, missing Settings). Styled as a system alert, not a model reply. |
| `agent_end` | `RUN_FINISHED` |

### 6.3 Deferred v1 capabilities with preserved extension points

Two capabilities are intentionally excluded from v1, but AgUiAdapter retains clear extension points so adding them does not require restructuring.

**a. Thinking/reasoning**

- Pi has `thinking_start`, `thinking_delta`, and `thinking_end`, including `redacted` and Google's `thoughtSignature`.
- They can later map to AG-UI `THINKING_*`. Redacted content is discarded, and `thoughtSignature` remains an internal Agent↔model mechanism that must never enter the frontend protocol.
- Add thinking events to `LoomAgentEvent` before implementing this mapping.

**b. Rich tool output**

- Pi's `AgentToolResult` naturally has two channels: `content` (text for the model) and `details` (structured data for UI rendering).
- Loom now preserves both channels: text maps to `TOOL_CALL_RESULT`, while structured details emit `CUSTOM loom.tool_result`.
- `search_assets` and `inspect_asset` use `asset_list` and `asset_detail` detail payloads. The current chat shell transports them; a later workbench renderer will display them as interactive asset cards.
- FFmpeg and ComfyUI progress can use additional `CUSTOM` events later.

---

## 7. Evals

Evals live in `packages/agent/evals/`. Compaction rate (`compaction-rate.ts`) is context tokens after compact / tokens before. Prompt-cache hit rate (`prompt-cache-hit.ts`) is `cacheRead / (input + cacheRead + cacheWrite)` from Chat usage (the API's `prompt_tokens` split).

```bash
pnpm --filter @loom/agent eval:compaction-rate
pnpm --filter @loom/agent eval:prompt-cache-hit
```

---

## 8. Summary

- **One vendored package:** pi-agent, available for source-level study and modification.
- **Three npm packages:** pi-ai, chord, and pi-telemetry, aligned with `UPSTREAM`.
- **Upstream merges:** pristine `vendor-clean` branch plus normal three-way merges.
- **Decoupling:** application code depends on `packages/agent/src/types.ts`; `pi-adapter.ts` is the sole vendor boundary through `#vendor/pi-agent`.
- **User attachments:** UI selection (and later injections) live on the user row as `attachments`, fold to one Chat `content` string in `convertToLlm`, and stay out of the bubble.
- **Frontend protocol:** CopilotKit/AG-UI over a localhost server in Main; AgUiAdapter translates LoomAgentEvent without leaking pi's protocol.
- **Evals:** compaction rate and prompt-cache hit rate; retrieval evals stay on the Hybrid Search step.
- **Current scope:** the question → answer → tool flow is complete; asset tools now preserve stable call IDs and structured result payloads. Thinking and interactive rich-result rendering remain deferred behind explicit extension points.
