**English** | [简体中文](./SETTINGS.zh-CN.md)

# Settings

> App-level model endpoints. Retrieval rules stay in [TEXT.md](./RAG/TEXT.md). Work items stay in [TODO.md](./TODO.md).
>
> Record conclusions here.

---

## Chat models

Settings → Models has one Chat card sharing the scrollbar with the four other model slots. Each model has an enable switch, not a default-model or thinking control. Provider headers show an auth-status dot; red dots expose an error tooltip. API key/OAuth, Edit, and Remove actions sit below the model list. Chat saves immediately; credentials are OS-encrypted in `chat-credentials.json` and never returned in ordinary reads. Explicit API-key editing prefills the stored or ambient key through its private login prompt, never OAuth tokens. Inputs are masked by default, with an eye toggle; cancel preserves credentials.

The Add provider dropdown includes Custom provider. Its inline editor supports name, complete Request URL, model IDs/display names, and adding/removing models. Advanced fields declare context/output ceilings and image/reasoning support. Only Save provider publishes the draft; Cancel creates nothing. Editing preserves provider identity, credentials, and unexposed metadata. Configure API keys through the separate button after saving. Keyless local servers that ignore authentication can use a placeholder key.

Custom Chat infers the protocol from the complete URL: `/chat/completions`, `/responses`, `/v1/messages`, or `/models/{model-id}:streamGenerateContent`. Standard paths show the detected protocol without a dropdown. Loom extracts the base prefix; pi-ai/SDK retains ownership of path construction, auth and streaming. Gemini URLs prefill a blank first model ID; requests use each configured model ID. Unknown paths can explicitly switch to Base URL + manual protocol mode, which still uses SDK-appended paths. Unsupported query parameters are rejected rather than dropped; native `beta=true` / `alt=sse` flags are accepted.

The composer model menu selects the conversation model. Hover a reasoning model or open its arrow to choose thinking strength in a submenu; keyboard users press Right to open it and Left to return. New conversations and existing conversations without a model prefer the last enabled, available choice, then the first enabled, available text model in configuration order. If none is available, the picker stays empty. Saved conversation/fork selections remain unchanged. Config and the remembered choice persist in `chat-models.json`. First-run `DEEPSEEK_API_KEY` enables native DeepSeek, making its models eligible for automatic selection.

History editing uses the same composer styling and model/thinking menus. It starts with the current conversation model; changes remain a draft until sending and are applied when creating the branch. Canceling leaves the source model unchanged. Permission remains the current app-wide setting.

### Chat runtime decisions

- **Split of work**: pi-ai owns providers, model catalogs, protocol conversion, auth resolution, OAuth refresh, streaming events, and usage. Loom owns configuration, credential persistence, UI, and selection policy. pi-durable owns scheduling, retries, compaction, cancellation, and recovery. Do not edit the vendor sources or implement OAuth or LLM protocols ourselves.
- **Storage** (all in the user-data directory, never in a library): `chat-models.json` holds non-secret configuration; `chat-credentials.json` is encrypted with safeStorage and holds one API-key or OAuth credential per provider, with secret headers stored by reference; `chat-model-catalog.json` caches dynamic catalogs and holds no credentials. A conversation's model and thinking level live in the durable conversation inside the library, without secrets. Credential changes, including during an OAuth refresh, hold a heartbeat-backed cross-process lock. Unavailable encryption or a failed decrypt is an error: no plaintext fallback and no silent reset.
- **Auth**: environment and other ambient auth is resolved by pi-ai and the UI shows its source. A stored credential that fails to resolve never silently falls back to the environment. Sign out deletes only the credential Loom stored; an environment key remains, and only disabling the provider stops new calls. The renderer never receives a stored key or token. Sign in and sign out take effect immediately, independent of settings drafts.
- **Catalogs**: in pi-ai 1.4.0 only Radius can refresh its catalog online; everything else uses the bundled static catalog, and a failed refresh keeps the old one. "Listed in the catalog", "auth configured", and "a call succeeded" are three different states.
- **Conversations**: the default model affects new conversations only; reopening keeps the chosen model; a fork keeps the choice at the branch point; a specialist inherits from its parent. An unavailable provider or invalid credential shows the reason and never switches the model automatically. While a conversation has foreground work, subtasks, or compaction running, its model cannot be changed, and the provider it uses cannot be edited, disabled, or removed.
- **Recovery**: a checkpoint stores only the model reference, thinking level, and a limited set of stream options. A resend uses the current provider metadata and defaults; fixed parameters across restarts are not promised.
- **Pricing and capability**: an unknown price shows as unknown, never 0. A custom model's capabilities must be declared; support for images or thinking is never assumed.
- **Packaging**: pi-ai ships as an external npm package. It must not be flattened into the app's `out/main`, because its OAuth modules use relative imports. `Provider.headers` is only metadata in pi-ai; headers are sent only through model headers or request options.
- **Platform check**: `pnpm --filter @loom/app check:chat-platform` (separate temporary user data, fake credentials, mock callbacks; needs local Electron and OS encryption).

## Model slots

The four remaining slots (Embedding, Rerank, VLM, Audio) share one form:

One Settings page. Same form for every role. Local and remote are the same fields: a URL is local if it points at this machine; a remote vendor is the same HTTP call plus an API key.

| Slot | Used for | Wire |
|---|---|---|
| Text embedding | Text RAG index | OpenAI-compatible `POST /v1/embeddings` |
| Rerank | Reorder Hybrid Search hits after RRF | Cohere/Jina `POST /v1/rerank` (`query` + `documents`). Bailian `qwen3-rerank` uses `POST .../compatible-api/v1/reranks`. Optional. |
| VLM | Image captions / tags; video file-level write-up | Same OpenAI-compatible `POST /v1/chat/completions`. Images use `image_url`. Video prefers a native video part when the endpoint allows it; otherwise FFmpeg frames as `image_url`. Vision only. |
| Audio | Audio file-level write-up (music, ambient sound, speech if any) | OpenAI-compatible `POST /v1/chat/completions` with an audio part. Hosted Qwen-Omni uses `input_audio` + `modalities: ["text"]` + `stream: true`. Not the VLM slot. |

Each slot stores:

- `requestUrl`: complete HTTP(S) **Request URL**, including operation path and optional query. No version/path is appended or rewritten. Examples: `https://…/v1/embeddings`, `https://…/v2/rerank`, `https://…/v1/chat/completions`.
- `apiKey` (hosted APIs usually need it; local servers often omit it)
- `model`
- `enabled` (the switch on the right of each slot)

Turn a slot on to send a tiny POST to its exact Request URL; no `/models` lookup or alternate route is tried. Embedding/Rerank checks use their native request/response shapes; VLM/Audio checks send text only and do not prove media capability. Green means the check passed; red shows the error. Save persists the configuration only. Disabled slots are not used at runtime. Previous base-only addresses are not migrated; enter full request URLs.

Loom never loads or runs a model. It is only an HTTP client.

TEI-native rerank (`texts` instead of `documents`) is not the first adapter. A server that only speaks TEI needs a proxy or a later adapter.

### Hosted Rerank

LM Studio has no `/v1/rerank`. Empty slot keeps RRF.

- **Baidu Qianfan:** Request URL `https://qianfan.baidubce.com/v2/rerank`, model `bce-reranker-base`, Qianfan key.
- **Alibaba Bailian:** Request URL `https://dashscope.aliyuncs.com/compatible-api/v1/reranks` (or intl), model `qwen3-rerank`. For `gte-rerank-v2`, enter `https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank`; its native payload is retained. URLs are never rewritten. Same DashScope key as Audio.

The Rerank switch POSTs a tiny rerank call. Green means that path worked, not `GET /v1/models`.

### Hosted Audio (Qwen-Omni)

LM Studio and typical OpenAI-compatible local servers only accept `text` / `image_url` on `/v1/chat/completions`. Baidu Qianfan’s compatible chat has no audio part. The remote path that works is **Alibaba DashScope compatible-mode** (user-filled; not a product default):

- China: `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- International: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
- Model: e.g. `qwen3-omni-flash` (or `qwen3.5-omni-plus` / `qwen3.8-omni-flash`)
- API key: a DashScope key

Green on the switch means a tiny text POST to the exact endpoint succeeded. It does not prove audio parts work. DashScope’s encoded audio cap is 10 MB; Loom still compacts files over 32 MB first.

---

## Storage

- Persist in the app user data directory, not `<library>/.loom/`. Copying a library must not copy API keys.
- Last opened library path is `last-library.json` in app user data. Startup reopens it when General says so and that folder still exists; a missing folder leaves the empty state and keeps the remembered path (a disconnected drive can come back). E2E uses its own userData, so it does not restore a host library.
- Keys stay in app user data, not the library. Each non-Chat slot has an API key button opening a prefilled, masked input dialog with an eye toggle. Confirm saves immediately; there is no page-level Save. Cancel/Escape discard dialog edits, and an empty confirmed value clears the key. Storage is unchanged; OS-keychain storage for these four slots remains future work.

---

## UI

- One Settings window with five tabs: **General**, **Models**, **MCP**, **Agent**, **Stats**. No page-level Save/Cancel buttons. Close never reverts saved changes. Writes are serialized; failures retain input and the previous valid stored configuration.
- Main serializes UI/tool mutations and their runtime updates. Model/general edits merge changed fields; Chat and MCP changes address individual providers/servers. Shared file locks protect read-modify-write across instances; temporary files atomically replace saved files, with Windows sharing-violation retries. MCP environment references remain unexpanded on disk.
- General: interface language (`system`, `en`, `zh-CN`) and whether startup reopens the last library. Language changes the app UI, including context menus. The trace window stays in English. Language and startup changes save immediately. Stored in app user data `general.json`. Reopen defaults to on, which is the previous startup behavior.
- Models: Chat plus four slots on one page. Non-Chat URL/model edits save on blur or Enter; switches save immediately. Valid commits to enabled slots trigger a connection check, not every keystroke. Invalid drafts never overwrite other slots. API-key dialogs persist only on Confirm; custom Chat retains its own Save provider/Cancel actions.
- Changing the embedding `model` invalidates existing text-RAG rows; see [TEXT.md](./RAG/TEXT.md). Changing the VLM `model` invalidates existing image and video write-ups; see [MEDIA.md](./RAG/MEDIA.md). Changing the Audio `model` invalidates existing audio write-ups.
- MCP: add/remove servers, with command + args or URL and advanced env/headers/cwd. Save server commits only that entry; unfinished sibling drafts stay local. Switches and removal persist immediately and apply live connections. Only enabled servers connect at startup. Stored in app user data `mcp.json` (or `LOOM_MCP_CONFIG`).
- Agent: a process-sandbox switch, on by default, stored in app user data `agent-sandbox.json`. What it wraps, and how Full permission overrides it, is in [PERMISSION](./agent/PERMISSION.md). Below it, standing instructions stay a free-text box in app user-data `AGENTS.md`, not in the library. The next session appends them at the end of the system prompt. Empty adds nothing. The session that is already running keeps the text it started with. The sandbox switch saves immediately. Instructions save after a 500 ms pause; switching tabs or closing flushes pending text. Text over 40,000 characters is retained for editing but not persisted. Retrieve and create specialists do not receive them.
- Stats: lifetime Chat usage. Prompt-cache hit rate is `cacheRead / (input + cacheRead + cacheWrite)`, the same formula as the agent eval. Also show the pi `SessionStats.usage` totals (input, output, cache read/write, turn count). Cost is omitted; catalog prices are estimates and unknown prices are not zeroed.
- `get_settings` and `update_settings` read and patch interface language, Chat providers/models, the four other model slots, MCP, sandbox, and instructions. Reads omit all keys and secret headers/env. Basic and Standard ask before writes; the UI updates automatically. Instructions apply on the next message. Startup preferences, permission, stats, OAuth login, and conversation model/thinking selection stay out of these tools. See [PERMISSION](./agent/PERMISSION.md).
- Language uses `language: "system" | "en" | "zh-CN"`. Chat uses `chat.upsert` / `chat.remove` with provider IDs, plus optional `chat.refresh`. `get_settings({chatProvider: "openai"})` includes that provider's model catalog. For custom providers, supply `kind: "custom"`, `models` (ID, reasoning, input, contextWindow, maxTokens), and a complete `requestUrl` or native `baseUrl` + `api`. Model lists replace; `modelEnabled` switches merge by ID. Existing conversations retain their choices; Settings never selects a replacement.
- Each Chat upsert can set `apiKey` or `clearApiKey: true`. Keys use encrypted Chat storage; clearing preserves OAuth/header secrets and cannot remove environment keys. Non-Chat key writes keep their existing storage behavior. Tool key arguments remain in conversation history—prefer the Settings key dialogs for secrets.
