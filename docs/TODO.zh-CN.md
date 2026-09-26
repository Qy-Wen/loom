[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近几步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

## 第一步：Hybrid Search

sqlite-vec 检索已有的 child 向量（Markdown 切片，以及图 / 视频转成的文字）。属性过滤仍是 AND。FTS 排名和向量排名用 **RRF** 融合（`k = 60`）。返回命中 + `asset_id`。默认不整库。见 [TEXT](./RAG/TEXT.zh-CN.md)。

- [x] sqlite-vec 检索已有 embedding 的 child 切片
- [x] 和 `assets_fts` 做 RRF 融合；child 命中可以扩到 parent
- [x] 建最小评测集

## 第二步：音频理解

只做独立音频文件。默认不整库。和图的 VLM 同一套：一次 HTTP 写说明（场景、音乐、环境声，有人声再带转写），再交给 Embedding 槽位。专用 Whisper ASR 和 CLAP 以后再做。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。

- [x] 设置里加 Audio 槽位（`baseUrl`、可选 key、`model`）。报文是 OpenAI 兼容 `POST /v1/chat/completions`，消息里带音频部分。VLM 槽位仍只做视觉。
- [x] 端点不收原格式时 FFmpeg 在本地转一版；体积上限比照视频。Loom 不跑模型
- [x] Markdown 按 `asset_id` 落盘，再 `embed_asset`。mtime 没变不重跑；换 Audio 模型则说明作废。Details / Agent 能请求并看到状态

## 第三步：Rerank

Hybrid Search 之后的可选第二轮。槽位空着就跳过。见 [TEXT](./RAG/TEXT.zh-CN.md)。

- [x] Cohere/Jina `POST /v1/rerank`，`query` + `documents`（融合后的段落）。TEI `texts` 以后再说
- [x] 失败保持 RRF 顺序。只有一条命中不调端点
- [x] `search_assets` 在槽位开启时使用

---

已完成的步骤存档见 [ARCHIVE](./archive/ARCHIVE.zh-CN.md)。

---

## 后续（概述）

- **进程内 OCR（可选）：** RapidOCR + ONNX，CPU，可开关，默认关。不一定做。优先 VLM。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **专用 ASR：** OpenAI 兼容 `POST /v1/audio/transcriptions`。优先 Audio 理解槽位。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **CLIP / 图片向量：** 不经文字、直接嵌图；需要时再做
- **会话历史面板：** 重启后在聊天区展示已恢复的 transcript
- **FFmpeg 进度与取消：** 长任务可中断，协议层推送进度
- **前端协议扩展：** AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **发布：** 小红书/抖音等平台适配
