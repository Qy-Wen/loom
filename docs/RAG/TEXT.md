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

`search_assets` is the retrieve step. It fuses `assets_fts` ranks with child-chunk vectors using **RRF** (`k = 60`). If the Rerank slot is on, those fused passages go to `POST /v1/rerank` (`query` + `documents`) before the limit is applied. Empty slot, one hit, or a failed rerank keeps the RRF order. Returns **passage + `asset_id`**. Property filters stay AND. A child hit can expand to its parent for more context. No query text lists the library with type/property filters only. No Embedding slot, or a failed query embed, is FTS-only.

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
- **Store:** `text_chunks` keyed by `asset_id` (chunk id, `parent_id`, role, offsets, text, mtime; child rows also have vector + model id). Not a blob in `asset_metadata`. sqlite-vec loads on open and scores those blobs with `vec_distance_cosine`. There is no `vec0` table: dimension follows the Embedding slot. If the extension is missing, the same cosine runs in JavaScript.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the embedding model invalidates the rows.

---

## Retrieve

- Embed the query once at search time through the Embedding slot (`POST /v1/embeddings`)
- sqlite-vec (or JS cosine) over **child** chunks that already have embeddings
- `assets_fts` ranks filename / path / properties / Level 1 / VLM text as today (`ORDER BY rank`)
- Property filters stay hard AND on both lists before fusion
- Fuse the two ranked `asset_id` lists with **RRF** (`score = Σ 1/(60 + rank)`, rank starts at 1). A hit in only one list still scores from that list. Collapse to one asset, attaching the nearest child passage. If the Rerank slot is on, send those passages as `documents`. Cohere/Jina/Qianfan use `POST /v1/rerank` (or `/v2/rerank`). Bailian `qwen3-rerank` uses `POST .../compatible-api/v1/reranks`; a DashScope Chat URL is rewritten. Failure or an empty slot keeps RRF. TEI-native `texts` waits.
- A hit can return the child passage and optionally the parent text
- Image / video / audio become text first, then the same chunks; see [MEDIA.md](./MEDIA.md)
- Minimal eval: `packages/core/tests/hybrid-search.test.ts` (FTS-only, vec-only, RRF + property AND, optional rerank). Gold-set Recall@k / nDCG: `packages/core/evals/`. Plan: [EVALS](../AGENT/EVALS.md).

---

## Provider

Loom is only an HTTP client. It does not ship weights, ONNX, or an in-process runtime.

- **Wire:** OpenAI-compatible `POST {baseUrl}/v1/embeddings` with `{ model, input }`.
- **Local or remote:** same fields. Local is a user-run server (Ollama, TEI, …). Remote is the same call plus an API key.
- Endpoints are user-configured. There is no built-in default vendor. Chat, embedding, rerank, VLM, and Audio share one Settings page; see [SETTINGS.md](../SETTINGS.md).
