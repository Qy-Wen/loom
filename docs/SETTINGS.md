**English** | [简体中文](./SETTINGS.zh-CN.md)

# Settings

> App-level model endpoints. Retrieval rules stay in [TEXT.md](./RAG/TEXT.md). Work items stay in [TODO.md](./TODO.md).
>
> Record conclusions here.

---

## Model slots

One Settings page. Same form for every role. Local and remote are the same fields: a URL is local if it points at this machine; a remote vendor is the same HTTP call plus an API key.

| Slot | Used for | Wire |
|---|---|---|
| Chat | Agent loop | OpenAI-compatible `POST /v1/chat/completions`. Same three fields as the other slots: `baseUrl`, optional API key, `model`. Not a hardcoded DeepSeek provider. |
| Text embedding | Text RAG index | OpenAI-compatible `POST /v1/embeddings` |
| Rerank | Reorder Hybrid Search hits after RRF | Cohere/Jina `POST /v1/rerank` (`query` + `documents`). Bailian `qwen3-rerank` uses `POST .../compatible-api/v1/reranks`. Optional. |
| VLM | Image captions / tags; video file-level write-up | Same OpenAI-compatible `POST /v1/chat/completions`. Images use `image_url`. Video prefers a native video part when the endpoint allows it; otherwise FFmpeg frames as `image_url`. Vision only. |
| Audio | Audio file-level write-up (music, ambient sound, speech if any) | OpenAI-compatible `POST /v1/chat/completions` with an audio part. Hosted Qwen-Omni uses `input_audio` + `modalities: ["text"]` + `stream: true`. Not the VLM slot. |

Each slot stores:

- `baseUrl`
- `apiKey` (hosted APIs usually need it; local servers often omit it)
- `model`
- `enabled` (the switch on the right of each slot)

Turn a slot on to ping it (`GET /v1/models`, then a tiny POST if that route is missing). Green is reachable; red shows the error. Save writes the file only. It does not connect. Disabled Chat / Embedding / Rerank / VLM / Audio slots are not used at runtime. Existing files without `enabled` stay on if they already had a URL and model.

Loom never loads or runs a model. It is only an HTTP client.

TEI-native rerank (`texts` instead of `documents`) is not the first adapter. A server that only speaks TEI needs a proxy or a later adapter.

### Hosted Rerank

LM Studio has no `/v1/rerank`. Empty slot keeps RRF.

- **Baidu Qianfan:** Base URL `https://qianfan.baidubce.com/v2`, model `bce-reranker-base`, Qianfan key.
- **Alibaba Bailian:** same DashScope Chat URL is fine (`https://dashscope.aliyuncs.com/compatible-mode/v1` or intl). Loom rewrites it to `.../compatible-api/v1/reranks`. Model `qwen3-rerank` (not the old `gte-rerank`). `gte-rerank-v2` uses DashScope’s native text-rerank path. Same DashScope key as Audio.

The Rerank switch POSTs a tiny rerank call. Green means that path worked, not `GET /v1/models`.

### Hosted Audio (Qwen-Omni)

LM Studio and typical OpenAI-compatible local servers only accept `text` / `image_url` on `/v1/chat/completions`. Baidu Qianfan’s compatible chat has no audio part. The remote path that works is **Alibaba DashScope compatible-mode** (user-filled; not a product default):

- China: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- International: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- Model: e.g. `qwen3-omni-flash` (or `qwen3.5-omni-plus` / `qwen3.8-omni-flash`)
- API key: a DashScope key

Green on the switch means the URL is reachable (`GET /v1/models`). It does not prove audio parts work. DashScope’s encoded audio cap is 10 MB; Loom still compacts files over 32 MB first.

---

## Storage

- Persist in the app user data directory, not `<library>/.loom/`. Copying a library must not copy API keys.
- Last opened library path is `last-library.json` in app user data. Startup reopens it if that folder still exists; a missing folder leaves the empty state and keeps the remembered path (a disconnected drive can come back). E2E uses its own userData, so it does not restore a host library.
- `<library>/.loom/config.json` stays library preferences only.
- Keys stay in app user data, not the library. Settings shows the key masked (`••••`); an eye toggle reveals the real value. Later they can move to the OS keychain.
- Chat is user-configured like Embedding. If the Chat slot is empty, Main may prefill once from `.env` (`DEEPSEEK_API_KEY` and a DeepSeek `baseUrl`) so existing dev setups still start. After the user saves Chat, that slot is the only source.

---

## UI

- One Settings window with three tabs: **Models**, **MCP**, **Stats**.
- Models: five slots on one page. Empty rerank / VLM / Audio slots are allowed. The switch pings; **Save** writes Models and MCP together and closes Settings.
- Changing the embedding `model` invalidates existing text-RAG rows; see [TEXT.md](./RAG/TEXT.md). Changing the VLM `model` invalidates existing image and video write-ups; see [MEDIA.md](./RAG/MEDIA.md). Changing the Audio `model` invalidates existing audio write-ups.
- MCP: add/remove servers. The form matches a Cursor `mcp.json` entry: name, then `command` + `args` (local) or `url` (remote). Env / headers / cwd sit under Advanced. The switch connects or disconnects that server. **Save** writes Models and MCP together. On app start, only enabled servers connect. Stored in app user data `mcp.json` (or `LOOM_MCP_CONFIG`). Starts empty; ComfyUI is one possible server, not a built-in.
- Stats: lifetime Chat usage. Prompt-cache hit rate is `cacheRead / (input + cacheRead + cacheWrite)`, the same formula as the agent eval. Also show the pi `SessionStats.usage` totals (input, output, cache read/write, turn count). Cost is omitted; the Chat slot does not set prices.
