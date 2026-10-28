[English](./TEXT.md) | **简体中文**

# 文本 RAG

> 第一条 RAG 路径：Markdown 和纯文本文件。总览见 [RAG.md](./RAG.zh-CN.md)。图 / 视频 / 音频见 [MEDIA.md](./MEDIA.zh-CN.md)。待办见 [TODO.md](../TODO.zh-CN.md)。
>
> 这里只记结论。

---

## 回路

```
磁盘上的 .md / .txt / .csv / .json
    → Level 1 文本摘录
    → 转成 Markdown（csv、json）
    → markdown-it（Markdown AST）
    → 父子切片 + embedding              （建索引）
    → 深度检索                     （检索）
    → Agent 回答或调用工具              （生成）
```

不要把整库塞进 prompt。默认不整库 embedding。

`deep_search_assets` 是检索步。只搜**切片**：块级全文（`chunks_fts`）和子切片向量，用 **RRF**（`k = 60`）融合。Rerank 槽位开着时，这些段落再走 `POST /v1/rerank`（`query` + `documents`），然后才截断。槽位空、只有一行、或 rerank 失败，都保持融合后的顺序。每个文件返回一个最佳 **段落 + `asset_id`**，附带父段落作上下文，以及 `indexedCount`。属性过滤仍是 AND。没有查询文本时只按类型/属性列出。Embedding 槽位未开或查询向量失败时只有全文一路。

`search_assets` 是简单检索，不碰切片，见 [RAG.md](./RAG.zh-CN.md)。

---

## 建索引

- **语料：** `.md`、`.txt`、`.csv`、`.json`。HTML、PDF、Office 文件不做。
- **转换：** `.md` 和 `.txt` 原样进入。CSV 每行一段，每个字段写成 `列名: 值`，所以每个切片都带着自己的列名。JSON 展开成 `路径: 值` 的行（`users[3].name: Ann`），超过约 1,200 字符的容器再拆成每个子元素一段。损坏或被截断的 JSON 按纯文本处理。切片偏移量指转换后的文本，不是原文件。
- **归一：** 转换后的文本先过 **markdown-it**，切分看的是 Markdown AST（标题、段落、列表），不先按字符硬切。
- **切分顺序：**
  1. 尽量按标题章节，再按段落（这是 markdown-it 的结构 token，不是大模型 token）。
  2. 长度用真 BPE 数。第一把尺是 **tiktoken `cl100k_base`**（本地 `js-tiktoken`，不跑模型）。512 / 64 指这套 token id，不是字符数。
  3. 还是超过 **512** token，再滑窗 **512**、重叠 **64**（步长 448）。
  4. 短文一篇一段。
- **父子：** 先切子切片，再聚合父切片。子切片用来找得准，父切片用来补上下文。先按结构 + 512 / 64 切出全部子切片，再把连续的子切片收成父切片，源文跨度不超过 **2048** token（大约四个子切片）。父切片正文是这段源文，不要把互相重叠的子切片字符串拼起来。父边界不按标题级别。根父节点的 `parent_id` 为空。只有子切片做 embedding。
- **输入：** 文本文件由索引自己从磁盘读取，不经过 Level 1 摘录，所以摘录 256 KiB 的上限不适用。读前 **1 MiB**（`TEXT_INDEX_LIMIT`，按字节，在 UTF-8 字符边界截断）；CSV 在这里被截断时，最后一行不完整，会被丢掉。更大的文件在 Index 区块里标为只索引了开头。图片、视频、音频索引的是描述 Markdown。embed 是单独的用户或 Agent 动作。
- **Provider：** `EmbeddingProvider`。Loom 不加载、不运行模型。报文是 OpenAI 兼容的 `POST /v1/embeddings`。`requestUrl`、API key、`model` 来自设置页的 Embedding 槽位，见 [设置](../SETTINGS.zh-CN.md)。
- **存储：** `text_chunks` 按 `asset_id`（切片 id、`parent_id`、角色、偏移、原文、mtime；子切片另存向量 + 模型名）。不塞进 `asset_metadata`。打开库时加载 sqlite-vec，用 `vec_distance_cosine` 打这些 blob。不上 `vec0` 表：维度跟着 Embedding 槽位。扩展没有就用 JavaScript 算同一套余弦。
- **失效：** 和 Level 1 一样看 mtime。rename/move 不重跑。换 embedding 模型则这些行作废。

---

## 检索

- 检索时用 Embedding 槽位把查询 embed 一次（`POST /v1/embeddings`）
- sqlite-vec（或 JS 余弦）只打已有向量的 **子切片**
- `chunks_fts` 用全文（`bm25`）给子切片排序。中文、日文、韩文先切成词，所以句子中间的词也能命中，见 [SEARCH.md](./SEARCH.zh-CN.md)
- 类型和属性过滤对两路都是硬 AND，融合前先滤
- 两路**切片**排名用 **RRF** 融合（`score = Σ 1/(60 + rank)`，rank 从 1 起）。只被一路找到的切片仍用那一路计分。每个文件只留最佳切片。重排正文始终是这个切片的文字，不会是文件名。Rerank 槽位开着时，这些正文作为 `documents` 再发。Cohere/Jina/千帆走 `POST /v1/rerank`（或 `/v2/rerank`）。百炼 `qwen3-rerank` 走 `POST .../compatible-api/v1/reranks`；填 DashScope 的 Chat URL 会被改写。失败或槽位空着就保持融合后的顺序。重排或 limit 丢掉的行不再补回。TEI 原生 `texts` 以后再说。
- 不沿关系扩展。没有索引的文件深度检索看不到，Agent 对它用 `search_assets`；`indexedCount` 告诉 Agent 深度检索能看到多少文件。
- 命中可返回子段落，并可带上父切片正文
- 图 / 视频 / 音频先转成文字再切，检索仍是这些切片，见 [MEDIA.md](./MEDIA.zh-CN.md)
- 最小评测：`packages/core/tests/deep-search.test.ts`（仅全文、仅向量、RRF + 属性 AND、可选 rerank、`indexedCount`、中文）和 `packages/core/tests/fts-store.test.ts`（块级全文、触发器、重建）。金标 Recall@k / nDCG：`packages/core/evals/`。方案见 [EVALS](../agent/EVALS.zh-CN.md)。

---

## Provider

Loom 只当 HTTP 客户端。不随包装权重，不上 ONNX，不在进程里跑模型。

- **报文：** OpenAI 兼容的 `POST {requestUrl}`，body 为 `{ model, input }`。
- **本地或远程：** 同一套字段。本地是用户自己起的服务（Ollama、TEI 等）。远程是同一套调用，外加 API key。
- 端点由用户配置，不内置默认供应商。Chat、embedding、rerank、VLM、Audio 共用一个设置页，见 [SETTINGS.md](../SETTINGS.zh-CN.md)。
