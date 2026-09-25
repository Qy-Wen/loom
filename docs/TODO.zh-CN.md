[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近三步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

## 第一步：模型设置

一个设置页，管 Chat / Embedding / Rerank / VLM。同一套字段：`baseUrl`、可选 API key、`model`。本地和远程同一张表。见 [SETTINGS.md](./SETTINGS.zh-CN.md)。

- [x] 槽位落到应用用户数据；设置页默认掩码，眼睛可显示明文 key
- [x] Chat 槽位（`baseUrl` + key + `model`）驱动 Agent，不写死 DeepSeek。空槽位可从 `.env` 预填一次
- [x] Embedding 走 OpenAI `POST /v1/embeddings`；Rerank 走 Cohere/Jina `/v1/rerank`；VLM 走 chat completions + `image_url`

## 第二步：文本 Embedding（RAG 建索引）

索引单位是切过的 **Markdown**，不是整篇一根向量。见 [TEXT](./RAG/TEXT.zh-CN.md)。默认不整库。图和视频以后再做。

- [ ] 切 Level 1 文本摘录（短文一篇一段；长文重叠切片）
- [ ] HTTP `EmbeddingProvider` 读 Embedding 槽位；切片 + 向量 + 模型名落盘；mtime 没变的 rename/move 不重算
- [ ] Details / Agent 能请求 embed 并看到状态

## 第三步：Hybrid Search（RAG 检索）

先检索切片，再用这些段落给 Agent 当依据。和现有的 FTS、属性过滤融合。

- [ ] sqlite-vec：只检索已有 embedding 的文本切片
- [ ] 在 `search_assets` / `hybrid_search` 后融合；返回段落 + `asset_id`
- [ ] 建立最小检索评测集

---

已完成的步骤存档见 [ARCHIVE](./archive/ARCHIVE.zh-CN.md)。

---

## 后续（概述）

- **图 / 视频 embedding：** CLIP 或抽一帧；走同一套 RAG 检索
- **Level 3 VLM：** 按需说明/标签；默认不整库富化
- **会话历史面板：** 重启后在聊天区展示已恢复的 transcript
- **FFmpeg 进度与取消：** 长任务可中断，协议层推送进度
- **前端协议扩展：** AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **发布：** 小红书/抖音等平台适配
