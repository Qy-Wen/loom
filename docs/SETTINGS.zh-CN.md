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
| Chat | Agent 循环 | OpenAI 兼容 `POST /v1/chat/completions`。和其它槽位一样填 `baseUrl`、可选 API key、`model`。不写死 DeepSeek。 |
| Embedding | 文本 RAG 索引 | OpenAI 兼容 `POST /v1/embeddings` |
| Rerank | 以后的检索 | Cohere/Jina `POST /v1/rerank`（`query` + `documents`） |
| VLM | 以后的 Level 3 | 同一套 chat completions；用户消息里带 `image_url` |

每个槽位存：

- `baseUrl`
- `apiKey`（可选；本地服务常常不需要）
- `model`

Loom 不加载、不运行模型。只当 HTTP 客户端。

TEI 原生存根（字段叫 `texts` 不叫 `documents`）不做第一家。只讲 TEI 的服务需要代理，或以后再加适配。

---

## 存储

- 落在应用用户数据目录，不进 `<library>/.loom/`。拷贝素材库时不能把 API key 一起拷走。
- `<library>/.loom/config.json` 只放库级偏好。
- 密钥留在 Main（以后进系统钥匙串）。Renderer 可以看 `baseUrl`、`model`，以及 key 是否已填。
- Chat 和 Embedding 一样由用户配置。Chat 槽位为空时，Main 可以从 `.env`（`DEEPSEEK_API_KEY` 和 DeepSeek 的 `baseUrl`）预填一次，方便现有开发环境启动。用户保存 Chat 之后，只认这个槽位。

---

## 界面

- 一个设置窗口或面板，不为每种模型单独弹窗。
- 四个槽位在同一页。Rerank / VLM 可以空着。
- 改 embedding 的 `model` 会使已有文本 RAG 行作废，见 [TEXT.md](./RAG/TEXT.zh-CN.md)。
- MCP 服务列表以后可以进这个窗口；不是第一批设置工作。见 PRODUCT.md §10。
