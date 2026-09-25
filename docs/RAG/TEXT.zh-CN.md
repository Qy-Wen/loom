[English](./TEXT.md) | **简体中文**

# 文本 RAG

> 第一条 RAG 路径：只做 Markdown。总览和以后的媒体见 [RAG.md](./RAG.zh-CN.md)。待办见 [TODO.md](../TODO.zh-CN.md)。
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

`search_assets` 是检索步。现在是 FTS。索引有了之后返回 **段落 + `asset_id`**，再和 FTS、属性过滤融合。子切片命中后可以扩到父切片，多带一截上下文。

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
- **存储：** 按 `asset_id` 的表（切片 id、`parent_id`、角色、偏移、原文、mtime；子切片另存向量 + 模型名）。不塞进 `asset_metadata`。先不上 sqlite-vec。
- **失效：** 和 Level 1 一样看 mtime。rename/move 不重跑。换 embedding 模型则这些行作废。

---

## 检索

- sqlite-vec 只打已有向量的 **子切片**
- 命中可返回子段落，并可带上父切片正文
- 和 `assets_fts`、属性过滤融合
- 以后图 / 视频 embedding 走同一条检索，见 [RAG.md](./RAG.zh-CN.md)

---

## Provider

Loom 只当 HTTP 客户端。不随包装权重，不上 ONNX，不在进程里跑模型。

- **报文：** OpenAI 兼容的 `POST {baseUrl}/v1/embeddings`，body 为 `{ model, input }`。
- **本地或远程：** 同一套字段。本地是用户自己起的服务（Ollama、TEI 等）。远程是同一套调用，外加 API key。
- 端点由用户配置，不内置默认供应商。Chat、embedding、rerank、VLM 共用一个设置页，见 [SETTINGS.md](../SETTINGS.zh-CN.md)。
