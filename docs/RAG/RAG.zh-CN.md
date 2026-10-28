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
    → 深度检索                      （检索）
    → Agent 回答或调用工具          （生成）
```

这就是 RAG。不要把整库塞进 prompt。默认不整库 embedding。

第一条路径是切过的 Markdown。规则见 [TEXT.md](./TEXT.zh-CN.md)。图 / 视频 / 音频先转成文字，再走同一套切片，见 [MEDIA.md](./MEDIA.zh-CN.md)。

检索是两个工具，按读取的内容分开：

- `search_assets` 是**简单检索**：文件级全文，覆盖文件名、路径、属性、摘录和描述，外加类型、属性过滤。不用模型、不需要索引，所有文件都能搜到。返回整个文件。
- `deep_search_assets` 是**深度检索**，即上面流程里的检索步：块级全文和块向量用 RRF 融合，可选 Rerank 槽位再排一次，每个文件返回一个最佳 **段落 + `asset_id`**。只能搜到已索引的文件，并返回 `indexedCount`。

两者都不沿关系扩展；想看某个文件的来源或派生文件，Agent 调 `inspect_asset`。见 [TEXT.md](./TEXT.zh-CN.md) 和 [SEARCH.md](./SEARCH.zh-CN.md)。

---

## 库任务生命周期

每次打开库都有独立的任务作用域。切库或关闭先停止接收任务与文件监听，再取消任务，等待存储回写及媒体清理结束，最后关闭存储。取消后排队任务不再启动，provider 的迟到结果不能发布到另一次打开的库。打开库时将中断遗留的描述/embedding 状态恢复为可重试的失败。详情读取及操作结果按当前打开批次、选区和请求校验。

图片、视频和音频描述通过组合共用 `rag/description.ts` 的执行流程及 `model/description.ts` 的记录/状态类型。各媒体服务保留独立串行队列和输入准备；公共流程处理缓存新鲜度、状态转换、失败及通知。LocalCore 继续将任务和通知绑定到当前库任务作用域。

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
| 1 | FFprobe（时长/分辨率/编码）、EXIF、文本内容提取 | 本地计算 | 自动 |
| 2 | Markdown 切片 embedding；图 / 视频 / 音频先转成文字再切，见 [MEDIA](./MEDIA.zh-CN.md) | 可选，HTTP provider（本地服务或远程 API key） | 用户选择 |
| 3 | VLM 给图片写 caption / 标签，给视频写文件级说明（native video 或抽帧）；Audio 槽位给音频写文件级说明 | 可能收费 | 用户选择 |
| 4 | 深度分析：分段、质量评分、风格标签等 | 可能收费 | 用户选择 |

- Level 1 写入按 `asset_id` 关联的 `asset_metadata`。失效判断用固定列；各类型字段放在带 `kind` 的 JSON 里（`image` / `video` / `audio` / `text`）。
- Level 1 从磁盘文件提取。缺失、失败或过期的记录在打开和 reconcile 后刷新。就绪记录重命名/移动不会重算。
- Level 2/3/4 的产物仍落在 SQLite（向量 + FTS + metadata），见 PRODUCT.md 第 3.2 节。

---

## 媒体

图 / 视频 / 音频的结论见 [MEDIA.md](./MEDIA.zh-CN.md)。图片是 VLM 写说明再文本 embedding。视频同一条路：端点允许就 native video，否则抽帧。音频走 Audio 槽位写说明，再走同一套文本 embedding。镜头切块以后再做。
