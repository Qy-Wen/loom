**English** | [简体中文](./TEXT.zh-CN.md)

# Text RAG

> First RAG path: Markdown only. Overview: [RAG.md](./RAG.md). Image / video / audio: [MEDIA.md](./MEDIA.md). Work items stay in [TODO.md](../TODO.md).
>
> Record conclusions here.

---

## Loop

```
.md file on disk
    → Level 1 text extract
    → markdown-it (Markdown AST)
    → parent / child chunks + embeddings    (index)
    → Hybrid Search                         (retrieve)
    → Agent answers or acts                 (generate / tools)
```

Do not stuff the library into the prompt. Do not embed the whole library by default.

`search_assets` is the retrieve step. It is FTS today. After the index exists it returns **passage + `asset_id`**, fused with FTS and property filters. A child hit can expand to its parent for more context.

---

## Index

- **Corpus:** `.md` only. Preview and Level 1 FTS may still cover txt / json / csv. Word and PDF are out.
- **Normalize:** run the Level 1 extract through **markdown-it** so splitting sees a Markdown AST (headings, paragraphs, lists). Work on that tree, not raw character windows first.
- **Split, in order:**
  1. Prefer heading sections, then paragraphs (markdown-it structure tokens — not LLM tokens).
  2. Count length with a real BPE tokenizer. First ruler is **tiktoken `cl100k_base`** (local `js-tiktoken`, no model). 512 / 64 are these token ids, not characters.
  3. If a unit is still over **512** tokens, slide a window of **512** with **64** overlap (step 448).
  4. A short file stays one chunk.
- **Parent / child:** children first, then pack. Children find the hit; parents fill in context. Cut all child slices first (structure, then 512 / 64). Then group consecutive children into parents until the source span would exceed **2048** tokens (about four children). Parent text is that source span, not a concat of overlapping child strings. Do not use heading level as the parent boundary. `parent_id` is null on a root parent. Only children get embeddings.
- **Input:** the Level 1 extract. If it is missing or stale, extract first. Analyze stays Level 1; embed is a separate user or Agent action.
- **Provider:** an `EmbeddingProvider`. Loom never loads or runs a model. Wire format is OpenAI-compatible `POST /v1/embeddings`. `baseUrl`, API key, and `model` come from the Embedding slot in [Settings](../SETTINGS.md).
- **Store:** a table keyed by `asset_id` (chunk id, `parent_id`, role, offsets, text, mtime; child rows also have vector + model id). Not a blob in `asset_metadata`. Not sqlite-vec yet.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the embedding model invalidates the rows.

---

## Retrieve

- sqlite-vec over **child** chunks that already have embeddings
- A hit can return the child passage and optionally the parent text
- Fuse with `assets_fts` and property filters
- Image / video / audio become text first, then the same chunks; see [MEDIA.md](./MEDIA.md)

---

## Provider

Loom is only an HTTP client. It does not ship weights, ONNX, or an in-process runtime.

- **Wire:** OpenAI-compatible `POST {baseUrl}/v1/embeddings` with `{ model, input }`.
- **Local or remote:** same fields. Local is a user-run server (Ollama, TEI, …). Remote is the same call plus an API key.
- Endpoints are user-configured. There is no built-in default vendor. Chat, embedding, rerank, and VLM share one Settings page; see [SETTINGS.md](../SETTINGS.md).
