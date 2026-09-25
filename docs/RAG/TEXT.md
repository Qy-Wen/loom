**English** | [简体中文](./TEXT.zh-CN.md)

# Text RAG

> First RAG path: Markdown only. Overview and later media stay in [RAG.md](./RAG.md). Work items stay in [TODO.md](../TODO.md).
>
> Record conclusions here. Open questions stay in [Open](#open).

---

## Loop

```
.md file on disk
    → Level 1 text extract
    → chunks + embeddings          (index)
    → Hybrid Search                (retrieve)
    → Agent answers or acts        (generate / tools)
```

Do not stuff the library into the prompt. Do not embed the whole library by default.

`search_assets` is the retrieve step. It is FTS today. After the index exists it returns **passage + `asset_id`**, fused with FTS and property filters.

---

## Index (Step 1)

- **Corpus:** `.md` only. Preview and Level 1 FTS may still cover txt / json / csv. Word and PDF are out.
- **Unit:** a chunk, not one vector per file. Short notes stay one chunk. Long notes are split with overlap (heading-aware split can come later).
- **Input:** the Level 1 extract. If it is missing or stale, extract first. Analyze stays Level 1; embed is a separate user or Agent action.
- **Provider:** an `EmbeddingProvider`. Loom never loads or runs a model. Wire format is OpenAI-compatible `POST /v1/embeddings`. `baseUrl`, optional API key, and `model` come from the Embedding slot in [Settings](../SETTINGS.md).
- **Store:** a table keyed by `asset_id` (chunk index, offsets, text, vector, model id, mtime). Not a blob in `asset_metadata`. Not sqlite-vec yet.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the embedding model invalidates the rows.

---

## Retrieve (Step 2)

- sqlite-vec over chunks that already have vectors
- Fuse with `assets_fts` and property filters
- Hits are passages the Agent can cite or open
- Image / video embeddings later reuse this path; see [RAG.md](./RAG.md)

---

## Provider

Loom is only an HTTP client. It does not ship weights, ONNX, or an in-process runtime.

- **Wire:** OpenAI-compatible `POST {baseUrl}/v1/embeddings` with `{ model, input }`.
- **Local or remote:** same fields. Local is a user-run server (Ollama, TEI, …). Remote is the same call plus an API key.
- Endpoints are user-configured. There is no built-in default vendor. Chat, embedding, rerank, and VLM share one Settings page; see [SETTINGS.md](../SETTINGS.md).
- Credentials stay out of the renderer, same rule as MCP.
