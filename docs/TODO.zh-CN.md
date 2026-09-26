[English](./TODO.md) | **简体中文**

# TODO

> 平铺的待办清单。产品设计见 [PRODUCT.md](./PRODUCT.zh-CN.md)，Agent 方案见 [AGENT.md](./AGENT.zh-CN.md)，模型端点见 [SETTINGS.md](./SETTINGS.zh-CN.md)，检索见 [RAG](./RAG/RAG.zh-CN.md)。
> 只详细列最近三步，后续只做概述。
> 创作工具（ComfyUI 以及以后的）以 MCP server 挂上。Loom 自管库：检索、FFmpeg、工作区工具。文件用 write/bash 落到库里，watcher 负责索引。路径 jail 和沙箱以后再加。

---

## 第一步：视频 VLM

按需做文件级说明，同一套 VLM 槽位，再走文本 embedding。默认不整库。镜头切块、逐镜 caption、音轨 ASR 以后再做。

端点能吃 **native video** 就优先整段视频（OpenAI 兼容 `chat/completions` 里的 video 部分，或供应商等价字段）。只会收图时，FFmpeg 抽帧再当 `image_url` 发。Loom 不加载、不运行模型。

- [x] 先判断 VLM 端点能不能 native video；不能再抽帧
- [x] 一篇说明对应一个视频资产落盘；mtime 没变的 rename/move 不重算
- [x] 拼成 Markdown 后交给 Embedding 槽位。Details / Agent 能请求并看到状态

## 第二步：音频转录

只做音频文件。默认不整库。先转写，再交给 Embedding 槽位。声学向量以后再做。

- [ ] 设置里加 ASR 槽位（`baseUrl`、可选 key、`model`）。报文是 OpenAI 兼容的 `POST /v1/audio/transcriptions`，要带时间戳的分段
- [ ] FFmpeg 在本地抽出音频；长文件切开再送，拼回时加上时间偏移。Loom 不跑模型
- [ ] 分段文本按 `asset_id` 落盘，再交给 Embedding 槽位。mtime 没变不重跑；换 ASR 模型则转录作废。Details / Agent 能请求并看到状态

## 第三步：Hybrid Search

sqlite-vec 检索已有的 child 向量（Markdown 切片，以及图 / 视频转成的文字）。和 FTS、属性过滤融合，返回命中 + `asset_id`。默认不整库。见 [TEXT](./RAG/TEXT.zh-CN.md)。

- [ ] sqlite-vec 检索已有 embedding 的 child 切片
- [ ] 和 `assets_fts`、属性过滤融合；child 命中可以扩到 parent
- [ ] 建最小评测集

---

已完成的步骤存档见 [ARCHIVE](./archive/ARCHIVE.zh-CN.md)。

---

## 后续（概述）

- **进程内 OCR（可选）：** RapidOCR + ONNX，CPU，可开关，默认关。不一定做。优先 VLM。见 [MEDIA](./RAG/MEDIA.zh-CN.md)。
- **CLIP / 图片向量：** 不经文字、直接嵌图；需要时再做
- **会话历史面板：** 重启后在聊天区展示已恢复的 transcript
- **FFmpeg 进度与取消：** 长任务可中断，协议层推送进度
- **前端协议扩展：** AgUiAdapter 补 thinking 与结构化工具结果的交互渲染，见 AGENT.md
- **发布：** 小红书/抖音等平台适配
