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
| Rerank | Later retrieve | Cohere/Jina `POST /v1/rerank` (`query` + `documents`) |
| VLM | Image captions / tags; video file-level write-up next | Same OpenAI-compatible `POST /v1/chat/completions`. Images use `image_url`. Video prefers a native video part when the endpoint allows it; otherwise FFmpeg frames as `image_url`. |

Each slot stores:

- `baseUrl`
- `apiKey` (hosted APIs usually need it; local servers often omit it)
- `model`
- `enabled` (the switch on the right of each slot)

Turn a slot on to ping it (`GET /v1/models`, then a tiny POST if that route is missing). Green is reachable; red shows the error. Save writes the file only. It does not connect. Disabled Chat / Embedding / VLM slots are not used at runtime. Existing files without `enabled` stay on if they already had a URL and model.

Loom never loads or runs a model. It is only an HTTP client.

TEI-native rerank (`texts` instead of `documents`) is not the first adapter. A server that only speaks TEI needs a proxy or a later adapter.

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
- Models: four slots on one page. Empty rerank / VLM slots are allowed. The switch pings; **Save** writes Models and MCP together and closes Settings.
- Changing the embedding `model` invalidates existing text-RAG rows; see [TEXT.md](./RAG/TEXT.md). Changing the VLM `model` invalidates existing image write-ups; see [MEDIA.md](./RAG/MEDIA.md).
- MCP: add/remove servers. The form matches a Cursor `mcp.json` entry: name, then `command` + `args` (local) or `url` (remote). Env / headers / cwd sit under Advanced. The switch connects or disconnects that server. **Save** writes Models and MCP together. On app start, only enabled servers connect. Stored in app user data `mcp.json` (or `LOOM_MCP_CONFIG`). Starts empty; ComfyUI is one possible server, not a built-in.
- Stats: lifetime Chat usage. Prompt-cache hit rate is `cacheRead / (input + cacheRead + cacheWrite)`, the same formula as the agent eval. Also show the pi `SessionStats.usage` totals (input, output, cache read/write, turn count). Cost is omitted; the Chat slot does not set prices.
