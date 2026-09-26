[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近三步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

## 第一步：图片 VLM

图先变成文字，再走已经做好的文本 embedding。不直接嵌图片向量。默认不整库。走设置里已有的 VLM 槽位：本地或远程都是 OpenAI 兼容 chat completions，消息里带 `image_url`。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。

- [x] HTTP 要 caption / 标签（可含图中可见文字）。本地服务和远程 API 同一套 `baseUrl` + 可选 key + `model`。Loom 不加载、不运行模型
- [x] 正文按资产落盘；mtime 没变的 rename/move 不重算
- [x] 拼成 Markdown 后交给 Embedding 槽位。槽位空着时正文仍留下。Details / Agent 能请求并看到状态

## 第二步：视频 VLM

抽一帧，走同一套 VLM。默认不整库。镜头和台词以后再做。

- [ ] FFmpeg 抽出一帧再发给 VLM；说明按资产落盘
- [ ] 拼成 Markdown 后交给 Embedding 槽位。mtime 没变不重跑；Details / Agent 能请求并看到状态

## 第三步：音频转录

只做音频文件。默认不整库。先转写，再交给 Embedding 槽位。声学向量以后再做。

- [ ] 设置里加 ASR 槽位（`baseUrl`、可选 key、`model`）。报文是 OpenAI 兼容的 `POST /v1/audio/transcriptions`，要带时间戳的分段
- [ ] FFmpeg 在本地抽出音频；长文件切开再送，拼回时加上时间偏移。Loom 不跑模型
- [ ] 分段文本按 `asset_id` 落盘，再交给 Embedding 槽位。mtime 没变不重跑；换 ASR 模型则转录作废。Details / Agent 能请求并看到状态

---

已完成的步骤存档见 [ARCHIVE](./archive/ARCHIVE.zh-CN.md)。

---

## 后续（概述）

- **Hybrid Search：** sqlite-vec 检索已有向量（文本切片、以及图 / 视频转成的文字）；和 FTS、属性过滤融合，返回命中 + `asset_id`；建最小评测集
- **进程内 OCR（可选）：** RapidOCR + ONNX，CPU，可开关，默认关。不一定做。优先 VLM。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **CLIP / 图片向量：** 不经文字、直接嵌图；需要时再做
- **会话历史面板：** 重启后在聊天区展示已恢复的 transcript
- **FFmpeg 进度与取消：** 长任务可中断，协议层推送进度
- **前端协议扩展：** AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **发布：** 小红书/抖音等平台适配
