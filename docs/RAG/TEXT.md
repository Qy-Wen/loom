**English** | [简体中文](./TEXT.zh-CN.md)

# Text RAG

> First RAG path: Markdown and plain-text files. Overview: [RAG.md](./RAG.md). Image / video / audio: [MEDIA.md](./MEDIA.md). Work items stay in [TODO.md](../TODO.md).
>
> Record conclusions here.

---

## Loop

```
.md / .txt / .csv / .json file on disk
    → Level 1 text extract
    → convert to Markdown (csv, json)
    → markdown-it (Markdown AST)
    → parent / child chunks + embeddings    (index)
    → Hybrid Search                         (retrieve)
    → Agent answers or acts                 (generate / tools)
```

Do not stuff the library into the prompt. Do not embed the whole library by default.

`search_assets` is the retrieve step. It fuses `assets_fts` ranks with child-chunk vectors using **RRF** (`k = 60`). One relation hop from those candidates joins the list. If the Rerank slot is on, those rows go to `POST /v1/rerank` (`query` + `documents`) before the limit is applied. Empty slot, one row, or a failed rerank keeps that order. Returns **passage + `asset_id`**. Property filters stay AND. A child hit can expand to its parent for more context. No query text lists the library with type/property filters only and does not walk relations. No Embedding slot, or a failed query embed, is FTS-only.

---

## Index

- **Corpus:** `.md`, `.txt`, `.csv`, `.json`. HTML, PDF, and Office files are out.
- **Convert:** `.md` and `.txt` go in as they are. CSV becomes one paragraph per row, each field written as `column: value`, so every chunk carries its own column names. JSON is flattened to `path: value` lines (`users[3].name: Ann`) and a container longer than about 1,200 characters is split into one paragraph per child. Broken or cut-off JSON stays plain text. Chunk offsets refer to the converted text, not the file.
- **Normalize:** run the converted text through **markdown-it** so splitting sees a Markdown AST (headings, paragraphs, lists). Work on that tree, not raw character windows first.
- **Split, in order:**
  1. Prefer heading sections, then paragraphs (markdown-it structure tokens — not LLM tokens).
  2. Count length with a real BPE tokenizer. First ruler is **tiktoken `cl100k_base`** (local `js-tiktoken`, no model). 512 / 64 are these token ids, not characters.
  3. If a unit is still over **512** tokens, slide a window of **512** with **64** overlap (step 448).
  4. A short file stays one chunk.
- **Parent / child:** children first, then pack. Children find the hit; parents fill in context. Cut all child slices first (structure, then 512 / 64). Then group consecutive children into parents until the source span would exceed **2048** tokens (about four children). Parent text is that source span, not a concat of overlapping child strings. Do not use heading level as the parent boundary. `parent_id` is null on a root parent. Only children get embeddings.
- **Input:** the Level 1 extract, which stops at 256 KB; a CSV cut there drops its last, partial row. If it is missing, failed, or stale, extract first. Embed is a separate user or Agent action.
- **Provider:** an `EmbeddingProvider`. Loom never loads or runs a model. Wire format is OpenAI-compatible `POST /v1/embeddings`. `requestUrl`, API key, and `model` come from the Embedding slot in [Settings](../SETTINGS.md).
- **Store:** `text_chunks` keyed by `asset_id` (chunk id, `parent_id`, role, offsets, text, mtime; child rows also have vector + model id). Not a blob in `asset_metadata`. sqlite-vec loads on open and scores those blobs with `vec_distance_cosine`. There is no `vec0` table: dimension follows the Embedding slot. If the extension is missing, the same cosine runs in JavaScript.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the embedding model invalidates the rows.

---

## Retrieve

- Embed the query once at search time through the Embedding slot (`POST /v1/embeddings`)
- sqlite-vec (or JS cosine) over **child** chunks that already have embeddings
- `assets_fts` ranks filename / path / properties / Level 1 / VLM text as today (`ORDER BY rank`)
- Property filters stay hard AND on both lists before fusion
- Fuse the two ranked `asset_id` lists with **RRF** (`score = Σ 1/(60 + rank)`, rank starts at 1). A hit in only one list still scores from that list. Collapse to one asset, attaching the nearest child passage. Before rerank, walk one hop from those candidates along asset relations, both directions. Each new file is its own row, at most 8 per candidate, with `linkedFrom` (candidate id, relation type, direction from the candidate). Skip ids already in the list. Type and property filters stay on the original candidates. The rerank document is still passage, parent passage, or filename. If the Rerank slot is on, send those documents. Cohere/Jina/Qianfan use `POST /v1/rerank` (or `/v2/rerank`). Bailian `qwen3-rerank` uses `POST .../compatible-api/v1/reranks`; a DashScope Chat URL is rewritten. Failure or an empty slot keeps the expanded RRF order. Rows that rerank or the limit drop are not added back. A query with no text does not walk the graph. TEI-native `texts` waits.
- A hit can return the child passage and optionally the parent text
- Image / video / audio become text first, then the same chunks; see [MEDIA.md](./MEDIA.md)
- Minimal eval: `packages/core/tests/hybrid-search.test.ts` (FTS-only, vec-only, RRF + property AND, optional rerank) and `packages/core/tests/graph-retrieval.test.ts` (relation hop before rerank). Gold-set Recall@k / nDCG: `packages/core/evals/`. Plan: [EVALS](../agent/EVALS.md).

---

## Provider

Loom is only an HTTP client. It does not ship weights, ONNX, or an in-process runtime.

- **Wire:** OpenAI-compatible `POST {requestUrl}` with `{ model, input }`.
- **Local or remote:** same fields. Local is a user-run server (Ollama, TEI, …). Remote is the same call plus an API key.
- Endpoints are user-configured. There is no built-in default vendor. Chat, embedding, rerank, VLM, and Audio share one Settings page; see [SETTINGS.md](../SETTINGS.md).
