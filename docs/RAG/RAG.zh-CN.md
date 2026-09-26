[English](./RAG.md) | **简体中文**

# RAG

> Agent 怎么用地上的库当依据。产品框在 [PRODUCT.md](../PRODUCT.zh-CN.md) §3.2 / §5，待办在 [TODO.md](../TODO.zh-CN.md)。
>
> 文本（第一条路径）：[TEXT.md](./TEXT.zh-CN.md)。图 / 视频 / 音频：[MEDIA.md](./MEDIA.zh-CN.md)。表结构：[SCHEMA.md](./SCHEMA.zh-CN.md)。

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

第一条路径是切过的 Markdown。规则见 [TEXT.md](./TEXT.zh-CN.md)。图 / 视频 / 音频先转成文字，再走同一套切片，见 [MEDIA.md](./MEDIA.zh-CN.md)。

`search_assets` 是检索步。返回 **段落 + `asset_id`**。属性过滤仍是 AND。FTS 和向量排名用 RRF 融合。见 [TEXT.md](./TEXT.zh-CN.md)。

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
| 2 | Markdown 切片 embedding；图 / 视频 / 音频先转成文字再切，见 [MEDIA](./MEDIA.zh-CN.md) | 可选，HTTP provider（本地服务或远程 API key） | 用户选择 |
| 3 | VLM 给图片写 caption / 标签，给视频写文件级说明（native video 或抽帧）；专用 OCR / ASR 以后 | 可能收费 | 用户选择 |
| 4 | 深度分析：分段、质量评分、风格标签等 | 可能收费 | 用户选择 |

- Level 1 写入按 `asset_id` 关联的 `asset_metadata`。失效判断用固定列；各类型字段放在带 `kind` 的 JSON 里（`image` / `video` / `audio` / `text`）。
- Level 1 从磁盘文件提取。缺失或过期记录在 reconcile 后刷新；Analyze 强制重跑。重命名/移动不会。
- Level 2/3/4 的产物仍落在 SQLite（向量 + FTS + metadata），见 PRODUCT.md 第 3.2 节。

---

## 媒体

图 / 视频 / 音频的结论见 [MEDIA.md](./MEDIA.zh-CN.md)。图片是 VLM 写说明再文本 embedding。视频同一条路：端点允许就 native video，否则抽帧。进程内 OCR + ONNX 是可选项，默认不做。镜头切块、CLIP 向量以后再做。
