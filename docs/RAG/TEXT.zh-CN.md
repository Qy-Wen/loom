[English](./TEXT.md) | **简体中文**

# 文本 RAG

> 第一条 RAG 路径：只做 Markdown。总览见 [RAG.md](./RAG.zh-CN.md)。图 / 视频 / 音频见 [MEDIA.md](./MEDIA.zh-CN.md)。待办见 [TODO.md](../TODO.zh-CN.md)。
>
> 这里只记结论。

---

## 回路

```
磁盘上的 .md
    → Level 1 文本摘录
    → markdown-it（Markdown AST）
    → 父子切片 + embedding              （建索引）
    → Hybrid Search                     （检索）
    → Agent 回答或调用工具              （生成）
```

不要把整库塞进 prompt。默认不整库 embedding。

`search_assets` 是检索步。用 **RRF**（`k = 60`）融合 `assets_fts` 排名和子切片向量。Rerank 槽位开着时，融合后的段落再走 `POST /v1/rerank`（`query` + `documents`），然后才截断。槽位空、只有一条命中、或 rerank 失败，都保持 RRF 顺序。返回 **段落 + `asset_id`**。属性过滤仍是 AND。子切片命中后可以扩到父切片。没有查询文本时只按类型/属性列出。Embedding 槽位未开或查询向量失败时退回 FTS。

---

## 建索引

- **语料：** 只做 `.md`。预览和 Level 1 FTS 仍可覆盖 txt / json / csv。Word、PDF 不做。
- **归一：** Level 1 摘录先过 **markdown-it**，切分看的是 Markdown AST（标题、段落、列表），不先按字符硬切。
- **切分顺序：**
  1. 尽量按标题章节，再按段落（这是 markdown-it 的结构 token，不是大模型 token）。
  2. 长度用真 BPE 数。第一把尺是 **tiktoken `cl100k_base`**（本地 `js-tiktoken`，不跑模型）。512 / 64 指这套 token id，不是字符数。
  3. 还是超过 **512** token，再滑窗 **512**、重叠 **64**（步长 448）。
  4. 短文一篇一段。
- **父子：** 先切子切片，再聚合父切片。子切片用来找得准，父切片用来补上下文。先按结构 + 512 / 64 切出全部子切片，再把连续的子切片收成父切片，源文跨度不超过 **2048** token（大约四个子切片）。父切片正文是这段源文，不要把互相重叠的子切片字符串拼起来。父边界不按标题级别。根父节点的 `parent_id` 为空。只有子切片做 embedding。
- **输入：** Level 1 摘录。没有或过期就先摘录。Analyze 仍是 Level 1；embed 是单独的用户或 Agent 动作。
- **Provider：** `EmbeddingProvider`。Loom 不加载、不运行模型。报文是 OpenAI 兼容的 `POST /v1/embeddings`。`baseUrl`、API key、`model` 来自设置页的 Embedding 槽位，见 [设置](../SETTINGS.zh-CN.md)。
- **存储：** `text_chunks` 按 `asset_id`（切片 id、`parent_id`、角色、偏移、原文、mtime；子切片另存向量 + 模型名）。不塞进 `asset_metadata`。打开库时加载 sqlite-vec，用 `vec_distance_cosine` 打这些 blob。不上 `vec0` 表：维度跟着 Embedding 槽位。扩展没有就用 JavaScript 算同一套余弦。
- **失效：** 和 Level 1 一样看 mtime。rename/move 不重跑。换 embedding 模型则这些行作废。

---

## 检索

- 检索时用 Embedding 槽位把查询 embed 一次（`POST /v1/embeddings`）
- sqlite-vec（或 JS 余弦）只打已有向量的 **子切片**
- `assets_fts` 仍按现在那样排文件名 / 路径 / 属性 / Level 1 / VLM 正文（`ORDER BY rank`）
- 属性过滤对两路都是硬 AND，融合前先滤
- 两路 `asset_id` 排名用 **RRF** 融合（`score = Σ 1/(60 + rank)`，rank 从 1 起）。只出现在一路里的命中仍用那一路计分。每个资产只留最近的子切片。Rerank 槽位开着时，这些段落作为 `documents` 再发。Cohere/Jina/千帆走 `POST /v1/rerank`（或 `/v2/rerank`）。百炼 `qwen3-rerank` 走 `POST .../compatible-api/v1/reranks`；填 DashScope 的 Chat URL 会被改写。失败或槽位空着就保持 RRF。TEI 原生 `texts` 以后再说。
- 命中可返回子段落，并可带上父切片正文
- 图 / 视频 / 音频先转成文字再切，检索仍是这些切片，见 [MEDIA.md](./MEDIA.zh-CN.md)
- 最小评测：`packages/core/tests/hybrid-search.test.ts`（仅 FTS、仅向量、RRF + 属性 AND、可选 rerank）。金标 Recall@k / nDCG：`packages/core/evals/`。方案见 [EVALS](../AGENT/EVALS.zh-CN.md)。

---

## Provider

Loom 只当 HTTP 客户端。不随包装权重，不上 ONNX，不在进程里跑模型。

- **报文：** OpenAI 兼容的 `POST {baseUrl}/v1/embeddings`，body 为 `{ model, input }`。
- **本地或远程：** 同一套字段。本地是用户自己起的服务（Ollama、TEI 等）。远程是同一套调用，外加 API key。
- 端点由用户配置，不内置默认供应商。Chat、embedding、rerank、VLM、Audio 共用一个设置页，见 [SETTINGS.md](../SETTINGS.zh-CN.md)。
