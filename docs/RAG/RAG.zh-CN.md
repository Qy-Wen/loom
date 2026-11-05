[English](./RAG.md) | **简体中文**

# RAG

> Loom 怎么把库里的文件变成 Agent 有依据的回答：索引什么、怎么检索、为什么这么做。产品框在 [PRODUCT.md](../PRODUCT.zh-CN.md) §3.2 / §5。表结构见 [SCHEMA.md](./SCHEMA.zh-CN.md)。待办见 [TODO.md](../TODO.zh-CN.md)。
>
> 这里只记结论。

---

## 回路

```
磁盘上的文件
    → Level 1 摘录
    → 文字（文本文件用原文；图片 / 视频 / 音频用它的描述）
    → 父子切片 + embedding          （建索引）
    → 深度检索                      （检索）
    → Agent 回答或调用工具          （生成）
```

不要把整库塞进 prompt。默认不整库建索引。媒体先变成文字，不会直接嵌成一根向量。

检索是两个工具：

| | 简单检索 `search_assets` | 深度检索 `deep_search_assets` |
|---|---|---|
| 单位 | 文件 | 块 |
| 数据源 | `assets_fts`：文件名、路径、属性、摘录、描述 | 块级全文 + 块向量 |
| 融合 | 无，单路排序 | RRF，只融合块 |
| 重排 | 无 | 有，输入永远是块正文 |
| 覆盖 | 所有文件 | 已索引的文件 |
| 模型 | 不需要 | Embedding、Rerank 均可选 |
| 返回 | 整个文件 | 每个文件一个最佳 **段落 + `asset_id`**，以及 `indexedCount` |

两者都不沿关系扩展，Agent 要看关系时调 `inspect_asset`。为什么分开：见[检索设计](#检索设计)。

---

## 文本索引

- **语料：** `.md`、`.txt`、`.csv`、`.json`。HTML、PDF、Office 文件不做。
- **转换：** `.md` 和 `.txt` 原样进入。CSV 每行一段，每个字段写成 `列名: 值`，所以每个切片都带着自己的列名。JSON 展开成 `路径: 值` 的行（`users[3].name: Ann`），超过约 1,200 字符的容器再拆成每个子元素一段。损坏或被截断的 JSON 按纯文本处理。切片偏移量指转换后的文本，不是原文件。
- **归一：** 转换后的文本先过 **markdown-it**，切分看的是 Markdown AST（标题、段落、列表），不先按字符硬切。
- **切分顺序：**
  1. 尽量按标题章节，再按段落（这是 markdown-it 的结构 token，不是大模型 token）。
  2. 长度用真 BPE 数：**tiktoken `cl100k_base`**（本地 `js-tiktoken`，不跑模型）。512 / 64 指这套 token id，不是字符数。
  3. 还是超过 **512** token，再滑窗 **512**、重叠 **64**（步长 448）。
  4. 短文一篇一段。
- **父子：** 子切片用来找得准，父切片用来补上下文。先切出全部子切片，再把连续的子切片收成父切片，源文跨度不超过 **2048** token（大约四个子切片）。父切片正文是这段源文，不要把互相重叠的子切片字符串拼起来。父边界不按标题级别。根父节点的 `parent_id` 为空。只有子切片做 embedding。
- **输入：** 文本文件由索引自己从磁盘读取，不经过 Level 1 摘录，所以摘录 256 KiB 的上限不适用。读前 **1 MiB**（`TEXT_INDEX_LIMIT`，按字节，在 UTF-8 字符边界截断）；CSV 在这里被截断时，最后一行不完整，会被丢掉。更大的文件在 Index 区块里标为只索引了开头。
- **Provider：** `EmbeddingProvider`：OpenAI 兼容的 `POST {requestUrl}`，body 为 `{ model, input }`，在[设置](../SETTINGS.zh-CN.md)的 Embedding 槽位里配置。
- **存储：** `text_chunks` 按 `asset_id`（切片 id、`parent_id`、角色、偏移、原文、mtime；子切片另存向量 + 模型名），以及块级全文表 `chunks_fts`。打开库时加载 sqlite-vec，用 `vec_distance_cosine` 打这些 blob。不上 `vec0` 表：维度跟着 Embedding 槽位。扩展没有就用 JavaScript 算同一套余弦。
- **失效：** 和 Level 1 一样看 mtime。rename/move 不重跑。换 embedding 模型则向量作废。

### 什么时候建索引

切块和向量绑在一起，只在用户点索引按钮或 Agent 调 `embed_asset` 时发生。“描述”只生成描述；“描述并索引”依次执行两步，描述失败就停止。导入和打开库也不切块。

- 原因：同步切块约 2 秒 / MiB，不适合对整库自动做；向量要调外部接口并产生费用，必须由用户主动触发。
- 后果：没建立索引的文件没有块，深度检索看不到它们。没配 Embedding 模型就建不了块。
- 后续可选：摘录之后在后台自动切块并建块级全文，向量仍手动。需要先有后台、可取消、会让出事件循环的任务机制，见 [TODO](../TODO.zh-CN.md)。

---

## 图片、视频、音频

媒体先变成一份 Markdown **描述**，再走上面的文本索引。描述是按需做的：导入不跑，由 Agent 或用户对单个文件请求。不会写 sidecar `.md` 进库（那会变成另一份资产）。

三者共通：

- Loom 只当 HTTP 客户端，模型不进进程。本地是用户自己起的服务，远程再加 API key，端点由用户配置，不内置默认供应商，见 [SETTINGS.md](../SETTINGS.zh-CN.md)。
- 描述拼成固定 Markdown，再交给 Embedding 槽位。槽位空着时正文仍留下。
- 失效和 Level 1 一样看 mtime。rename/move 不重跑。换 VLM 或 Audio 模型则描述作废；换 Embedding 模型则切片向量作废。

### 图片

- **VLM 槽位：** OpenAI 兼容 `POST {requestUrl}`，用户消息里带 `image_url`（本地文件用 data URI）。
- **产出：** caption 和标签；图中可见文字也可以写进描述。

```markdown
## Caption
...
## Tags
...
```

### 视频

和图片共用 VLM 槽位。一个文件对应一篇 Markdown 描述。

1. **Native video：** 端点能收就整段发。`POST /v1/chat/completions`，带 `video_url` data URI（文件不超过 32 MB）。Qwen3-VL 这类模型可以。native 返回 400/413/415/422/5xx 时，按端点+模型记住一次，本进程后续改抽帧。
2. **抽帧当 `image_url`：** native 跳过或被拒时，FFmpeg 抽 1–3 张临时 JPEG（大约片长的 10% / 50% / 90%；短片更少）。不进素材库。

镜头切块、逐镜 caption、音轨理解以后再做。长目标是分段索引，不是整片一根向量：

```
video.mp4
├── 文件级描述                                     （现在）
├── Scene 1    00:00-00:08   caption + embedding   （以后）
├── Scene 2    00:08-00:21   caption + embedding   （以后）
└── transcript chunks                              （以后）
```

「找那个人物从车里走下来的镜头」到时会定位到 `video.mp4  01:13 - 01:18`，再调 `extract_clip`。这条工具链现在还没有。

### 音频

独立音频文件。用单独的 Audio 槽位，不是 VLM 槽位（那个槽位只做视觉）：一个模型既能写音乐 / 环境声，有人声再转写。

- **报文：** OpenAI 兼容 `POST {requestUrl}`，用户消息里带音频部分。LM Studio 的 `/v1/chat/completions` 收不了音频，千帆兼容 chat 没有音频部分。托管 Qwen-Omni 走 DashScope compatible-mode（`input_audio.data` 用 `data:;base64,...` + `modalities: ["text"]` + `stream: true`）；看起来像 DashScope 的 URL 先发 Omni。其它 URL 先 `audio_url`，再 `input_audio`，再 Omni。
- **体积：** 端点不收原格式时 FFmpeg 在本地转一版。data URI 不超过 32 MB，超过就压成 16 kHz 单声道 MP3。DashScope 编码后音频上限 10 MB。视频音轨以后复用这个槽位。
- **存储：** `audio_writeup` 按 `asset_id`；Details 显示 Caption，`describe_audio` 写入，`embed_asset` 把它折进 `text_chunks`。

```markdown
## Caption
...
## Tags
...
## Transcript
... 仅当有人声 ...
```

### 媒体文件的索引是什么

- 短描述是一个父块加一个子块。实测：带标签的两行说明得到 1 个父块、1 个子块；17,000 字的长描述得到 2 个父块、8 个子块。一张普通图片的「最佳段落」就是整段说明。
- 命中返回的是描述文字，不是图像或声音的内容。描述里漏掉的细节找不到。
- 简单检索也覆盖描述，所以说明里的词不需要索引就能找到文件。
- 索引的新旧跟着描述走：描述比索引保存得晚，或与文件的修改时间对不上，索引就算过期。
- 切块的偏移量指向描述的 Markdown。视频、音频的命中暂时没有时间范围。
- 描述和索引是独立操作，各有状态与重试按钮。多媒体只有在描述成功且未过期时才显示索引区域。Agent 需要两者时，先 `describe_*` 再 `embed_asset`。

---

## 深度检索

`deep_search_assets` 只搜**切片**：

- **向量：** 用 Embedding 槽位把查询 embed 一次（`POST /v1/embeddings`），再用 sqlite-vec（或 JS 余弦）只打已有向量的**子切片**。
- **全文：** `chunks_fts` 用 `bm25` 给子切片排序。中文、日文、韩文先切成词，见[下文](#中日韩文字)。
- **过滤：** 类型、属性、标签和收藏过滤对两路都是硬 AND，融合前先滤。简单检索用同样的过滤。文件必须同时带有所列的每个标签，不是标签的名字不匹配任何文件。
- **融合：** 两路**切片**排名用 **RRF**（`score = Σ 1/(60 + rank)`，rank 从 1 起）。只被一路找到的切片仍用那一路计分。每个文件只留最佳切片。
- **重排：** Rerank 槽位开着时，切片正文在截断前送去重排；正文始终是切片的文字，不会是文件名。Cohere/Jina/千帆走 `POST /v1/rerank`（或 `/v2/rerank`）。百炼 `qwen3-rerank` 走 `POST .../compatible-api/v1/reranks`；填 DashScope 的 Chat URL 会被改写。槽位空、只有一行、或失败，都保持融合后的顺序。重排或 limit 丢掉的行不再补回。TEI 原生 `texts` 以后再说。
- **结果：** 每个文件一个最佳 **段落 + `asset_id`**，附带父段落作上下文，以及 `indexedCount`。没有查询文本时只按过滤条件列出。Embedding 槽位未开或查询向量失败时只有全文一路。
- 没有索引的文件深度检索看不到，Agent 对它用 `search_assets`。`indexedCount` 告诉 Agent 深度检索能看到多少文件。

最小评测：`packages/core/tests/deep-search.test.ts`（仅全文、仅向量、RRF + 属性 AND、可选 rerank、`indexedCount`、中文）和 `packages/core/tests/fts-store.test.ts`（块级全文、触发器、重建）。金标 Recall@k / nDCG：`packages/core/evals/`。方案见 [EVALS](../agent/EVALS.zh-CN.md)。

---

## 检索设计

### 为什么是两种检索

全文以前一文件一行，向量一块一行，融合时被硬压成文件，只有全文命中的文件没有正文片段，重排只能看到文件名。一个工具还把零成本的关键词检索和要付费的语义检索混在一起，Agent 无法选择。现在深度检索只搜块，不带文件级全文；没索引的文件用简单检索找。

三层数据，各管各的：

| 层 | 内容 | 上限 | 用途 |
|---|---|---|---|
| 原文 | 磁盘文件 | 无 | 事实来源 |
| 摘录 | `asset_metadata.data.text` | 256 KiB | Details 预览、简单检索 |
| 块 | `text_chunks` + `chunks_fts` | 读原文件前 1 MiB | 向量检索、深度检索 |

索引自己读原文件，不读摘录，所以摘录的上限不会限制索引覆盖的范围。

### 中日韩文字

FTS5 内置分词器里没有按单字或按词切中文的（`unicode61`、`ascii`、`porter` 把连续中文当成一个词；`trigram` 要求至少 3 个字；`icu` 在当前 SQLite 里不可用），所以搜「天气」找不到「今天天气很好」。Loom 用 `Intl.Segmenter("zh", { granularity: "word" })` 先分词，再把结果交给 `unicode61`：

- 写入时，连续的 CJK 文本切成词，用空格连接（`今天天气很好` → `今天 天气 很好`）。英文和数字不变。`assets_fts` 和 `chunks_fts` 都这样做。
- 查询时，同一个函数给查询里的 CJK 段分词，每段编成一个短语（`"人工 智能"`），保证词序和相邻；非 CJK 词仍是 `"word"*`，整体 AND。
- 分词函数独立成模块（`retrieval/tokenize.ts`），存储层与查询共用。
- 全文索引格式版本（分词器版本加运行环境的 ICU 版本）存在 `library_meta.fts_format`。打开库时版本不一致就重建两张表，所以以后改分词、升级 Electron 都不需要额外步骤。

用本机真实中文文档（22,682 个段落，约 420 万字符，汉字占 37%）在真实 FTS5 上实测：

| 做法 | 索引体积 | 搜完整的词：召回 | 搜完整的词：精度 | 搜任意片段：召回 |
|---|---|---|---|---|
| 不处理 | 19.7 MB | 0.30 | 1.00 | 0.20 |
| 单字拆开 + 短语 | 24.8 MB（+26%） | 1.00 | 0.999 | 1.00 |
| **`Intl.Segmenter`** | **20.7 MB（+5%）** | **0.97** | **1.00** | **0.42** |
| Segmenter + 长词子词 | 20.9 MB（+6%） | 0.98 | 1.00 | 0.43 |

「完整的词」是用 Segmenter 从文本里取出的 2 到 4 字词；「任意片段」是随机截取的 2 到 4 字子串，常跨词。

代价：

1. **只能按词搜，不能按任意片段搜。** 跨词的片段（如「气很好」）约一半找不到。真实用户很少搜这种片段，但文件名里的一段、专有名词的一部分会受影响。若实际使用中发现「搜片段」是常见需求，可退回单字拆开。
2. **长词内部的短词可能搜不到。** `研究生院` 被切成 `研究生 / 院`，搜「研究」找不到它。补长词子词几乎没有提升（0.97 → 0.98），所以不做。
3. **依赖运行环境的 ICU 版本。** Electron 38（ICU 74.2）与 Node 26（ICU 78.3）在六个例句上切法一致，但生词、专有名词可能不同；上面的格式版本通过重建来应对。
4. **日文、韩文用中文词典分词。** 切得动但不一定准，日文常会切成单个假名。改用 `ja`、`ko` 会更准，本次没做。
5. **升级后第一次打开要重建两张表。** 在 2,062 个文件、22,682 个子块的合成库上约 1.4 秒，之后正常打开约 50 毫秒。重建发生在打开库的路径上，库大 10 倍可能到十几秒；若有影响，改成后台进行，完成前先用旧表。

考虑过的其他做法：`trigram`（两个字的词搜不到）、相邻两字（更大，且搜不到单字）、随包带词典的分词库（切法与 ICU 无关，但词典大、打包成本高）、自写 FTS5 分词器扩展（要编译原生代码并跨平台发布）。

### 检索不沿关系扩展

检索以前会把每个候选一跳之外的关联文件一并带上，现在不做了：两种检索都没有 `linkedFrom` 行，Agent 用 `inspect_asset` 查看一个文件的关系。关系本身（图谱视图、Details、`create_relation`、`remove_relation`）不变。

- 代价：找邻居要对每个命中多调一次；只靠关系关联、文本上不相似的文件（描述里没提「海报」的源视频）不再自动出现在检索里。
- 以后若需要：加 `related_assets(assetId)` 一次返回邻居，或给 `deep_search_assets` 加默认关闭的 `includeRelated` 开关。

### 风险与未验证

- 同步切块约 2 秒 / MiB，一个 1 MiB 的文件会让主进程停约 2 秒。后续可放 worker 或分片让出事件循环。
- 超过 1 MiB 的 JSON 因截断解析失败，退化成纯文本，不展开成 `路径: 值`。
- 未验证：中文文件名、路径被分词后对现有排序的影响；日文、韩文的分词效果；实测只用了一份偏技术的中英混排文档，纯文学、新闻、聊天记录的结果可能不同。

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
| 2 | Markdown 切片 embedding；图 / 视频 / 音频先转成文字再切，见 [图片、视频、音频](#图片视频音频) | 可选，HTTP provider（本地服务或远程 API key） | 用户选择 |
| 3 | VLM 给图片写 caption / 标签，给视频写文件级说明（native video 或抽帧）；Audio 槽位给音频写文件级说明 | 可能收费 | 用户选择 |
| 4 | 深度分析：分段、质量评分、风格标签等 | 可能收费 | 用户选择 |

- Level 1 写入按 `asset_id` 关联的 `asset_metadata`。失效判断用固定列；各类型字段放在带 `kind` 的 JSON 里（`image` / `video` / `audio` / `text`）。
- Level 1 从磁盘文件提取。缺失、失败或过期的记录在打开和 reconcile 后刷新。就绪记录重命名/移动不会重算。
- Level 2/3/4 的产物仍落在 SQLite（向量 + FTS + metadata），见 PRODUCT.md 第 3.2 节。

---

## 库任务生命周期

每次打开库都有独立的任务作用域。切库或关闭先停止接收任务与文件监听，再取消任务，等待存储回写及媒体清理结束，最后关闭存储。取消后排队任务不再启动，provider 的迟到结果不能发布到另一次打开的库。打开库时将中断遗留的描述/embedding 状态恢复为可重试的失败。详情读取及操作结果按当前打开批次、选区和请求校验。

图片、视频和音频描述通过组合共用 `rag/description.ts` 的执行流程及 `model/description.ts` 的记录/状态类型。各媒体服务保留独立串行队列和输入准备；公共流程处理缓存新鲜度、状态转换、失败及通知。LocalCore 继续将任务和通知绑定到当前库任务作用域。
