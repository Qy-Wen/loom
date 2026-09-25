[English](./TEXT.md) | **简体中文**

# 文本 RAG

> 第一条 RAG 路径：只做 Markdown。总览和以后的媒体见 [RAG.md](./RAG.zh-CN.md)。待办见 [TODO.md](../TODO.zh-CN.md)。
>
> 这里只记结论。未决写在 [未决](#未决)。

---

## 回路

```
磁盘上的 .md
    → Level 1 文本摘录
    → 切片 + embedding              （建索引）
    → Hybrid Search                 （检索）
    → Agent 回答或调用工具          （生成）
```

不要把整库塞进 prompt。默认不整库 embedding。

`search_assets` 是检索步。现在是 FTS。索引有了之后返回 **段落 + `asset_id`**，再和 FTS、属性过滤融合。

---

## 建索引（第一步）

- **语料：** 只做 `.md`。预览和 Level 1 FTS 仍可覆盖 txt / json / csv。Word、PDF 不做。
- **单位：** 切片，不是整篇一根向量。短笔记一篇一段；长文重叠切开（按标题切以后再加）。
- **输入：** Level 1 摘录。没有或过期就先摘录。Analyze 仍是 Level 1；embed 是单独的用户或 Agent 动作。
- **Provider：** `EmbeddingProvider`。Loom 不加载、不运行模型。报文是 OpenAI 兼容的 `POST /v1/embeddings`。`baseUrl`、可选 API key、`model` 来自设置页的 Embedding 槽位，见 [设置](../SETTINGS.zh-CN.md)。
- **存储：** 按 `asset_id` 的表（切片序号、偏移、原文、向量、模型名、mtime）。不塞进 `asset_metadata`。先不上 sqlite-vec。
- **失效：** 和 Level 1 一样看 mtime。rename/move 不重跑。换 embedding 模型则这些行作废。

---

## 检索（第二步）

- sqlite-vec 只打已有向量的切片
- 和 `assets_fts`、属性过滤融合
- 命中是 Agent 能引用或打开的段落
- 以后图 / 视频 embedding 走同一条检索，见 [RAG.md](./RAG.zh-CN.md)

---

## Provider

Loom 只当 HTTP 客户端。不随包装权重，不上 ONNX，不在进程里跑模型。

- **报文：** OpenAI 兼容的 `POST {baseUrl}/v1/embeddings`，body 为 `{ model, input }`。
- **本地或远程：** 同一套字段。本地是用户自己起的服务（Ollama、TEI 等）。远程是同一套调用，外加 API key。
- 端点由用户配置，不内置默认供应商。Chat、embedding、rerank、VLM 共用一个设置页，见 [SETTINGS.md](../SETTINGS.zh-CN.md)。
- 密钥不进 renderer，规则同 MCP。
