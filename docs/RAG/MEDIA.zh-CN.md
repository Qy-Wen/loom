[English](./MEDIA.md) | **简体中文**

# 多模态 RAG

> 图 / 视频 / 音频怎么进同一条检索。总览见 [RAG.md](./RAG.zh-CN.md)。Markdown 切片见 [TEXT.md](./TEXT.zh-CN.md)。待办见 [TODO.md](../TODO.zh-CN.md)。
>
> 这里只记结论。

---

## 回路

媒体先变成 **文字**，再走文本 RAG。不把图或视频直接嵌成一根向量。

```
磁盘上的图 / 视频 / 音频
    → 转成 Markdown（VLM / 音频理解）
    → 同一套父子切片 + Embedding 槽位     （建索引）
    → Hybrid Search                        （检索）
    → Agent 回答或调用工具                 （生成）
```

不要把整库塞进 prompt。默认不整库。不写一份 sidecar `.md` 进库（那会变成另一份资产）。

检索仍是 `search_assets`：命中是 **段落 + `asset_id`**。视频以后可以带时间范围。

---

## 图

用户或 Agent 对单张图请求。导入不跑。

- **VLM：** 设置里已有的 VLM 槽位。报文是 OpenAI 兼容 `POST {baseUrl}/v1/chat/completions`，用户消息里带 `image_url`（本地文件用 data URI）。本地部署和远程 API 同一张表；远程一般要填 API key，本地常常不需要。Loom 不加载、不运行模型。
- **产出：** caption / 标签；图中可见文字也可以写进这段说明。拼成固定 Markdown，再交给 Embedding 槽位。槽位空着时正文仍留下。
- **不直接嵌图。** 检索走这份 Markdown，再文本 embedding。
- **失效：** 和 Level 1 一样看 mtime。rename/move 不重跑。换 VLM 模型则说明作废。换 Embedding 模型则切片向量作废。

拼法：

```markdown
## Caption
...
## Tags
...
```

---

## 视频

按需做文件级说明，和图片共用 VLM 槽位。默认不整库。

**怎么把视频送给模型**

1. **Native video：** 端点能收就整段发。报文是 OpenAI 兼容 `POST /v1/chat/completions`，带 `video_url` data URI（文件不超过 32 MB）。Qwen3-VL 这类模型可以。Loom 只当 HTTP 客户端；除了组请求，不在进程里解码视频。native 返回 400/413/415/422/5xx 时，按端点+模型记住一次，本进程后续改抽帧。
2. **抽帧当 `image_url`：** native 跳过或被拒时，FFmpeg 抽 1–3 张临时 JPEG（大约片长的 10% / 50% / 90%；短片更少）。不进素材库。

这一步一篇 Markdown 对应整个文件。镜头切块、逐镜 caption、音轨理解以后再做。长目标仍是分段索引，不是整片一根向量：

```
video.mp4
│
├── 文件级说明（这一步：能 native 就 native，否则抽帧）
│
├── Scene 1    00:00-00:08   caption + embedding   （以后）
├── Scene 2    00:08-00:21   caption + embedding   （以后）
└── transcript chunks                              （以后）
```

用户可以问「找一下那个『人物从车里走下来』的镜头」。Agent 定位到 `video.mp4  01:13 - 01:18`，然后 `search_video_segments()` → `extract_clip(73s, 78s)`。这一步还没有这条工具链。

---

## 音频

独立音频文件。按需做文件级说明，和图片 VLM 同一思路：一个模型既能写音乐 / 环境声，有人声再转写。导入不跑。不要复用 VLM 槽位（那个槽位只做视觉）。

- **Audio 槽位：** OpenAI 兼容 `POST {baseUrl}/v1/chat/completions`，用户消息里带音频部分。本地和远程同一套字段。不内置默认供应商。Loom 不加载、不运行模型。LM Studio 的 `/v1/chat/completions` 收不了音频。千帆兼容 chat 没有音频部分。托管 Qwen-Omni 走 DashScope compatible-mode（`input_audio.data` 用 `data:;base64,...` + `modalities: ["text"]` + `stream: true`）。本地 OpenAI 兼容音频服务仍先试 `audio_url` 再试 `input_audio`。
- **产出：** caption / 标签；有人声再写进 Transcript。拼成固定 Markdown，再交给 Embedding 槽位。槽位空着时正文仍留下。
- **不直接嵌波形。** 检索走这份 Markdown，再文本 embedding。
- **失效：** 和 Level 1 一样看 mtime。rename/move 不重跑。换 Audio 模型则说明作废。换 Embedding 模型则切片向量作废。
- 端点不收原格式时 FFmpeg 在本地转一版。体积上限比照视频（data URI，不超过 32 MB）。超过上限时压成 16 kHz 单声道 MP3。看起来像 DashScope 的 URL 先发 Omni（`input_audio`、stream、只要文本 modalities）。其它 URL 先 `audio_url`，再 `input_audio`，再 Omni。DashScope 编码后音频上限 10 MB。视频音轨以后复用这个槽位，不另做一套。
- **存储：** `audio_writeup` 按 `asset_id`。Details Caption 和 `describe_audio`；再用 `embed_asset` 把 Markdown 折进 `text_chunks`。Embedding 槽位空着时正文仍留下。不写 sidecar `.md`。

拼法：

```markdown
## Caption
...
## Tags
...
## Transcript
... 仅当有人声 ...
```

---

## Provider

Loom 只当 HTTP 客户端。VLM 和 Audio 模型不进进程。

- **报文：** OpenAI 兼容的 `POST {baseUrl}/v1/chat/completions`。图片用 `image_url`（本地文件用 data URI）。视频先试 `video_url`（data URI，不超过 32 MB）；否则抽帧再当 `image_url`。音频走 Audio 槽位：托管 Omni 用流式 `input_audio`；其它端点再试 `audio_url` / `input_audio`。不走 VLM 槽位。
- **本地或远程：** 同一套字段（`baseUrl`、可选 API key、`model`）。本地是用户自己起的服务。目前能用的远程音频是 DashScope compatible-mode 的 Qwen-Omni，不是千帆。见 [SETTINGS.md](../SETTINGS.zh-CN.md)。
- 端点由用户配置，不内置默认供应商。见 [SETTINGS.md](../SETTINGS.zh-CN.md)。

---

## 检索

图 / 视频 / 音频的向量都是 **文字切片** 的向量，和 Markdown 走同一张 `text_chunks`、同一套 Hybrid Search。不要为媒体另开一条向量检索。

sqlite-vec、和 FTS 的 RRF 融合、属性过滤见 [TEXT.md](./TEXT.zh-CN.md)。
