[English](./RAG.md) | **简体中文**

# RAG

> Agent 怎么用地上的库当依据。产品框在 [PRODUCT.md](../PRODUCT.zh-CN.md) §3.2 / §5，待办在 [TODO.md](../TODO.zh-CN.md)。
>
> 文本（第一条路径）：[TEXT.md](./TEXT.zh-CN.md)。表结构：[SCHEMA.md](./data/SCHEMA.zh-CN.md)。

---

## 回路

```
磁盘上的文件
    → Level 1 摘录
    → 切片 + embedding              （建索引）
    → Hybrid Search                 （检索）
    → Agent 回答或调用工具          （生成）
```

这就是 RAG。不要把整库塞进 prompt。默认不整库 embedding。

第一条路径是切过的 Markdown。规则见 [TEXT.md](./TEXT.zh-CN.md)。图和视频以后走同一条检索。

`search_assets` 是检索步。现在是 FTS。索引有了之后返回 **段落 + `asset_id`**，再和 FTS、属性过滤融合。

---

## 富化层级

资产的理解程度分层递进，用户可控、成本可控。**不是所有文件都值得做 AI 理解**。用户主动选择是否为某资产做 embedding / 语义分析，避免「一导入就疯狂烧 API 钱」。

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
| 2 | 先做 Markdown 切片 embedding（文本 RAG）；图/视频以后 | 可选，HTTP provider（本地服务或远程 API key） | 用户选择 |
| 3 | VLM 语义理解：caption / 场景 / 人物 / OCR / ASR | 可能收费 | 用户选择 |
| 4 | 深度分析：分段、质量评分、风格标签等 | 可能收费 | 用户选择 |

- Level 1 写入按 `asset_id` 关联的 `asset_metadata`。失效判断用固定列；各类型字段放在带 `kind` 的 JSON 里（`image` / `video` / `audio` / `text`）。
- Level 1 从磁盘文件提取。缺失或过期记录在 reconcile 后刷新；Analyze 强制重跑。重命名/移动不会。
- Level 2/3/4 的产物仍落在 SQLite（向量 + FTS + metadata），见 PRODUCT.md 第 3.2 节。

---

## 视频（以后）

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

用户可以问「找一下那个『人物从车里走下来』的镜头」。Agent 定位到 `video.mp4  01:13 - 01:18`，然后 `search_video_segments()` → `extract_clip(73s, 78s)`。
