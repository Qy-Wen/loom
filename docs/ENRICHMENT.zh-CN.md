[English](./ENRICHMENT.md) | **简体中文**

# 资产富化与媒体理解（Enrichment & Media Understanding）

> 本文档是 [PRODUCT.md](./PRODUCT.zh-CN.md) 第 5 节「Progressive Enrichment」的展开，记录资产富化的分层细节、各媒体类型的处理流程，以及视频的多粒度理解方案。
>
> PRODUCT.md 只保留大框架，具体处理管线与设计细节在此维护。

---

## 1. Progressive Enrichment 分层

资产的理解程度分层递进，用户可控、成本可控。

```
Level 0  Filesystem metadata        免费
   ↓
Level 1  FFprobe / EXIF / 文本提取   本地计算
   ↓
Level 2  Embedding                  可选
   ↓
Level 3  VLM Semantic Understanding 可选、可能收费
   ↓
Level 4  Deep Analysis              可选
```

| Level | 内容 | 成本 | 触发 |
|-------|------|------|------|
| 0 | 文件系统元数据：path、size、hash、mtime、type | 免费 | 自动（导入即有） |
| 1 | FFprobe（时长/分辨率/编码）、EXIF、文本内容提取 | 本地计算 | 自动或按需 |
| 2 | 先做文本切片 embedding（RAG 索引）；图/视频以后 | 可选（本地或云） | 用户选择 |
| 3 | VLM 语义理解：caption / 场景 / 人物 / OCR / ASR | 可能收费 | 用户选择 |
| 4 | 深度分析：分段、质量评分、风格标签等 | 可能收费 | 用户选择 |

设计原则：**不是所有文件都值得做 AI 理解**。用户主动选择是否为某资产做 embedding / 语义分析，避免「一导入就疯狂烧 API 钱」。

---

## 2. 示例：一个视频的富化流程

刚加入时（Level 0 / 1）：

```
video.mp4
duration:   120s
resolution: 4K
codec:      H264
```

用户点击「AI 分析」后（Level 2 / 3）：

```
FFmpeg
 ↓ 关键帧抽取
VLM caption
 ↓
ASR（转录）
 ↓
OCR
 ↓
Embedding
```

得到：

```
内容：      一个女生在海边使用手机拍照
人物：      女性
场景：      海边 / 日落
产品：      手机
风格：      暖色 / lifestyle
Transcript: ...
Embedding:  [...]
```

---

## 3. 视频的多粒度理解

视频不应只生成一个 embedding。应做分段（scene）与转录分块（transcript chunk）级别的索引。

```
video.mp4
│
├── Asset embedding
│
├── Scene 1
│    ├── 00:00-00:08
│    ├── caption
│    └── embedding
│
├── Scene 2
│    ├── 00:08-00:21
│    ├── caption
│    └── embedding
│
└── transcript chunks
```

这样用户可以问：

> 找一下那个「人物从车里走下来」的镜头。

Agent 直接定位到片段：

```
video.mp4  01:13 - 01:18
```

然后：

```
search_video_segments()
        ↓
extract_clip(73s, 78s)
```

资产搜索由此升级为 **Agent 真正理解并操作媒体内容**。

---

## 4. 与检索层的关系（RAG）

Level 1 摘录 → Level 2 切片和向量 → Hybrid Search → Agent 用这些段落。这就是 RAG。默认不整库 embedding。

- Level 1 写入按 `asset_id` 关联的 `asset_metadata`。失效判断用固定列；各类型字段放在带 `kind` 的 JSON 里（`image` / `video` / `audio` / `text`）。
- Level 1 从磁盘文件提取。缺失或过期记录在 reconcile 后刷新；Analyze 强制重跑。重命名/移动不会。
- Level 2 先做文本切片（短文一篇一段）。每段存原文、偏移、向量、模型名。Analyze 仍是 Level 1；embed 是单独的用户/Agent 动作。
- Hybrid Search 检索这些切片，返回段落 + `asset_id`，Agent 可以引用或打开文件。sqlite-vec 和融合等索引有了再做。
- 图/视频 embedding，以及之后的镜头 / 台词切块，走同一套检索。
- Level 2/3/4 的产物仍落在 SQLite（向量 + FTS + metadata），见 PRODUCT.md 第 3.2 节。
