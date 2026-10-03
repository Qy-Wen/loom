[English](./SETTINGS.md) | **简体中文**

# 设置

> 应用级的模型端点。检索规则见 [TEXT.md](./RAG/TEXT.zh-CN.md)。待办见 [TODO.md](./TODO.zh-CN.md)。
>
> 这里只记结论。

---

## 模型槽位

一个设置页。每种角色同一套表单。本地和远程字段相同：URL 指本机就是本地；远程供应商是同一套 HTTP，外加 API key。

| 槽位 | 用途 | 报文 |
|---|---|---|
| Chat | Agent 循环 | OpenAI 兼容 `POST /v1/chat/completions`。和其它槽位一样填 `baseUrl`、可选 API key、`model`。输入框的图以 `image_url` 发出。端点拒绝时界面报错，这一轮不留在当前路径上。不写死 DeepSeek。 |
| Text embedding | 文本 RAG 索引 | OpenAI 兼容 `POST /v1/embeddings` |
| Rerank | Hybrid Search 融合后再排一次 | Cohere/Jina `POST /v1/rerank`（`query` + `documents`）。百炼 `qwen3-rerank` 走 `POST .../compatible-api/v1/reranks`。可选。 |
| VLM | 图片 caption / 标签；视频文件级说明 | 和 Chat 一样走 OpenAI 兼容 `POST /v1/chat/completions`。图片用 `image_url`。视频能 native 就带 video 部分；否则 FFmpeg 抽帧再当 `image_url`。只做视觉。 |
| Audio | 音频文件级说明（音乐、环境声，有人声再转写） | OpenAI 兼容 `POST /v1/chat/completions`，消息里带音频部分。托管 Qwen-Omni 发 `input_audio` + `modalities: ["text"]` + `stream: true`。不走 VLM 槽位。 |

每个槽位存：

- `baseUrl`
- `apiKey`（远程托管一般要填；本地服务常常不需要）
- `model`
- `enabled`（每个槽位右边的开关）

打开开关会 ping（先 `GET /v1/models`，没有这个路由再发一个很小的 POST）。通了绿灯，失败红灯并写出原因。保存只写配置文件，不负责连服务。关掉的 Chat / Embedding / Rerank / VLM / Audio 运行时不会用。旧文件没有 `enabled` 时，只要已经填了 URL 和 model，就当作开着。

Loom 不加载、不运行模型。只当 HTTP 客户端。

TEI 原生存根（字段叫 `texts` 不叫 `documents`）不做第一家。只讲 TEI 的服务需要代理，或以后再加适配。

### 托管 Rerank

LM Studio 没有 `/v1/rerank`。槽位空着就保持 RRF。

- **百度千帆：** Base URL `https://qianfan.baidubce.com/v2`，模型 `bce-reranker-base`，用千帆的 key。
- **阿里云百炼：** 可以填和 Chat 一样的 DashScope URL（`https://dashscope.aliyuncs.com/compatible-mode/v1` 或国际站）。Loom 会改写成 `.../compatible-api/v1/reranks`。模型用 `qwen3-rerank`（不要用已下线的 `gte-rerank`）。`gte-rerank-v2` 走 DashScope 原生 text-rerank。Key 和 Audio 同一把 DashScope key。

Rerank 开关会发一次很小的 rerank POST。绿灯表示这条路径通了，不是 `GET /v1/models`。

### 托管 Audio（Qwen-Omni）

LM Studio 和常见本地 OpenAI 兼容服务的 `/v1/chat/completions` 只收 `text` / `image_url`。百度千帆兼容 chat 没有音频部分。能用的远程是 **阿里云 DashScope compatible-mode**（用户自己填，不是产品默认）：

- 国内：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 国际：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- 模型：例如 `qwen3-omni-flash`（或 `qwen3.5-omni-plus` / `qwen3.8-omni-flash`）
- API key：DashScope 的 key

开关绿灯只表示 URL 通了（`GET /v1/models`），不表示音频部分可用。DashScope 编码后音频上限 10 MB；Loom 仍先把超过 32 MB 的文件压一遍。

---

## 存储

- 落在应用用户数据目录，不进 `<library>/.loom/`。拷贝素材库时不能把 API key 一起拷走。
- 上次打开的素材库路径记在应用用户数据 `last-library.json`。启动时目录还在就自动打开；目录没了就保持空库，路径仍留下（移动硬盘拔掉再插回来还能认）。E2E 用独立 userData，不会打开本机上次的库。
- `<library>/.loom/config.json` 只放库级偏好。
- 密钥留在应用用户数据，不进素材库。设置页默认掩码（`••••`），旁边眼睛可显示明文。以后可以再进系统钥匙串。
- Chat 和 Embedding 一样由用户配置。Chat 槽位为空时，Main 可以从 `.env`（`DEEPSEEK_API_KEY` 和 DeepSeek 的 `baseUrl`）预填一次，方便现有开发环境启动。用户保存 Chat 之后，只认这个槽位。

---

## 界面

- 一个设置窗口，三个 tab：**Models**、**MCP**、**Stats**。
- Models：五个槽位在同一页。Rerank / VLM / Audio 可以空着。开关负责 ping；**Save** 同时写入 Models 和 MCP，然后关掉设置。
- 改 embedding 的 `model` 会使已有文本 RAG 行作废，见 [TEXT.md](./RAG/TEXT.zh-CN.md)。改 VLM 的 `model` 会使已有图 / 视频说明作废，见 [MEDIA.md](./RAG/MEDIA.zh-CN.md)。改 Audio 的 `model` 会使已有音频说明作废。
- MCP：加减 server。表单按 Cursor `mcp.json` 来：名字，然后本地填 `command` + `args`，远程填 `url`。Env / headers / cwd 放在 Advanced。开关连接或断开那一台。**Save** 同时写入 Models 和 MCP。启动时只连已开启的 server。存在应用用户数据 `mcp.json`（或 `LOOM_MCP_CONFIG`）。默认空列表；ComfyUI 只是其中一种，不是内置。
- Stats：应用级累计的 Chat usage。Prompt-cache 命中率是 `cacheRead / (input + cacheRead + cacheWrite)`，和 agent eval 同一公式。同时展示 pi `SessionStats.usage` 的合计（input、output、cache read/write、轮次）。不展示费用；当前 Chat 槽位没有标价。
