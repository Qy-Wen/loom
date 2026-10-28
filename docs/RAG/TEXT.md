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
    → deep search                           (retrieve)
    → Agent answers or acts                 (generate / tools)
```

Do not stuff the library into the prompt. Do not embed the whole library by default.

`deep_search_assets` is the retrieve step. It searches **chunks** only: chunk full text (`chunks_fts`) and child-chunk vectors, fused with **RRF** (`k = 60`). If the Rerank slot is on, the passages go to `POST /v1/rerank` (`query` + `documents`) before the limit is applied. Empty slot, one row, or a failed rerank keeps the fused order. Returns one best **passage + `asset_id`** per file, with the parent passage for context, and `indexedCount`. Property filters stay AND. No query text lists the library with type/property filters only. No Embedding slot, or a failed query embed, is full text only.

`search_assets` is the simple search and does not touch chunks; see [RAG.md](./RAG.md).

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
- **Input:** a text file is read from disk by the index itself, not from the Level 1 extract, so the extract's 256 KiB cap does not apply. It reads the first **1 MiB** (`TEXT_INDEX_LIMIT`, bytes, cut on a UTF-8 boundary); a CSV cut there drops its last, partial row. A larger file is marked partial in the Index block. An image, video, or audio file indexes its write-up Markdown instead. Embed is a separate user or Agent action.
- **Provider:** an `EmbeddingProvider`. Loom never loads or runs a model. Wire format is OpenAI-compatible `POST /v1/embeddings`. `requestUrl`, API key, and `model` come from the Embedding slot in [Settings](../SETTINGS.md).
- **Store:** `text_chunks` keyed by `asset_id` (chunk id, `parent_id`, role, offsets, text, mtime; child rows also have vector + model id). Not a blob in `asset_metadata`. sqlite-vec loads on open and scores those blobs with `vec_distance_cosine`. There is no `vec0` table: dimension follows the Embedding slot. If the extension is missing, the same cosine runs in JavaScript.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the embedding model invalidates the rows.

---

## Retrieve

- Embed the query once at search time through the Embedding slot (`POST /v1/embeddings`)
- sqlite-vec (or JS cosine) over **child** chunks that already have embeddings
- `chunks_fts` ranks child chunks by full text (`bm25`). Chinese, Japanese, and Korean are cut into words first, so a word in the middle of a sentence matches; see [SEARCH.md](./SEARCH.md)
- Property and type filters stay hard AND on both lists before fusion
- Fuse the two ranked **chunk** lists with **RRF** (`score = Σ 1/(60 + rank)`, rank starts at 1). A chunk found by only one list still scores from that list. Keep each file's best chunk. The rerank document is always that chunk's text, never a filename. If the Rerank slot is on, send those documents. Cohere/Jina/Qianfan use `POST /v1/rerank` (or `/v2/rerank`). Bailian `qwen3-rerank` uses `POST .../compatible-api/v1/reranks`; a DashScope Chat URL is rewritten. Failure or an empty slot keeps the fused order. Rows that rerank or the limit drop are not added back. TEI-native `texts` waits.
- Relations are not walked. A file with no index is invisible to deep search; the Agent uses `search_assets` for it, and `indexedCount` tells it how many files deep search can see.
- A hit can return the child passage and optionally the parent text
- Image / video / audio become text first, then the same chunks; see [MEDIA.md](./MEDIA.md)
- Minimal eval: `packages/core/tests/deep-search.test.ts` (full text only, vectors only, RRF + property AND, optional rerank, `indexedCount`, Chinese) and `packages/core/tests/fts-store.test.ts` (chunk full text, triggers, rebuild). Gold-set Recall@k / nDCG: `packages/core/evals/`. Plan: [EVALS](../agent/EVALS.md).

---

## Provider

Loom is only an HTTP client. It does not ship weights, ONNX, or an in-process runtime.

- **Wire:** OpenAI-compatible `POST {requestUrl}` with `{ model, input }`.
- **Local or remote:** same fields. Local is a user-run server (Ollama, TEI, …). Remote is the same call plus an API key.
- Endpoints are user-configured. There is no built-in default vendor. Chat, embedding, rerank, VLM, and Audio share one Settings page; see [SETTINGS.md](../SETTINGS.md).
