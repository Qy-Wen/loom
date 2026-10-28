**English** | [简体中文](./RAG.zh-CN.md)

# RAG

> How Loom turns library files into grounded Agent answers: what gets indexed, how it is searched, and why. Product framing is in [PRODUCT.md](../PRODUCT.md) §3.2 / §5. Tables are in [SCHEMA.md](./SCHEMA.md). Work items are in [TODO.md](../TODO.md).
>
> Record conclusions here.

---

## Loop

```
file on disk
    → Level 1 extract
    → text (a text file as it is; an image / video / audio file as its write-up)
    → parent / child chunks + embeddings    (index)
    → deep search                           (retrieve)
    → Agent answers or acts                 (generate / tools)
```

Do not stuff the library into the prompt. Do not index the whole library by default. Media becomes text first and is never embedded as one vector.

Retrieval is two tools:

| | Simple `search_assets` | Deep `deep_search_assets` |
|---|---|---|
| Unit | file | chunk |
| Source | `assets_fts`: filename, path, properties, extract, caption | chunk full text + chunk vectors |
| Fusion | none, one ranking | RRF over chunks only |
| Rerank | none | yes, input is always chunk text |
| Coverage | every file | indexed files |
| Models | none | Embedding and Rerank optional |
| Returns | whole files | one best **passage + `asset_id`** per file, and `indexedCount` |

Neither follows relations; the Agent calls `inspect_asset` for those. Why they are split: [Search design](#search-design).

---

## Text index

- **Corpus:** `.md`, `.txt`, `.csv`, `.json`. HTML, PDF, and Office files are out.
- **Convert:** `.md` and `.txt` go in as they are. CSV becomes one paragraph per row, each field written as `column: value`, so every chunk carries its own column names. JSON is flattened to `path: value` lines (`users[3].name: Ann`) and a container longer than about 1,200 characters is split into one paragraph per child. Broken or cut-off JSON stays plain text. Chunk offsets refer to the converted text, not the file.
- **Normalize:** run the converted text through **markdown-it** so splitting sees a Markdown AST (headings, paragraphs, lists), not raw character windows.
- **Split, in order:**
  1. Prefer heading sections, then paragraphs (markdown-it structure tokens, not LLM tokens).
  2. Count length with a real BPE tokenizer: **tiktoken `cl100k_base`** (local `js-tiktoken`, no model). 512 / 64 are these token ids, not characters.
  3. If a unit is still over **512** tokens, slide a window of **512** with **64** overlap (step 448).
  4. A short file stays one chunk.
- **Parent / child:** children find the hit; parents fill in context. Cut all child slices first, then group consecutive children into parents until the source span would exceed **2048** tokens (about four children). Parent text is that source span, not a concat of overlapping child strings. Heading level is not a parent boundary. `parent_id` is null on a root parent. Only children get embeddings.
- **Input:** a text file is read from disk by the index itself, not from the Level 1 extract, so the extract's 256 KiB cap does not apply. It reads the first **1 MiB** (`TEXT_INDEX_LIMIT`, bytes, cut on a UTF-8 boundary); a CSV cut there drops its last, partial row. A larger file is marked partial in the Index block.
- **Provider:** an `EmbeddingProvider`: OpenAI-compatible `POST {requestUrl}` with `{ model, input }`, configured in the Embedding slot in [Settings](../SETTINGS.md).
- **Store:** `text_chunks` keyed by `asset_id` (chunk id, `parent_id`, role, offsets, text, mtime; child rows also have vector + model id), and `chunks_fts` for chunk full text. sqlite-vec loads on open and scores the blobs with `vec_distance_cosine`. There is no `vec0` table: dimension follows the Embedding slot. If the extension is missing, the same cosine runs in JavaScript.
- **Invalidation:** same mtime rule as Level 1. Rename/move does not rerun. Changing the embedding model invalidates the vectors.

### When indexing happens

Chunking and vectors go together. They happen only when the user clicks Embed, the Agent calls `embed_asset`, or an image / video / audio write-up finishes and indexing follows. Importing and opening a library do not chunk.

- Why: synchronous chunking takes about 2 s per MiB, too heavy to run over a whole library on its own; vectors call an external API and cost money, so the user must ask for them.
- Result: a file that was never embedded has no chunks and deep search cannot see it. Without an Embedding model no chunks are built.
- Later option: build chunks and chunk full text in the background after the extract, and keep only the vectors manual. It needs a cancellable background task that yields to the event loop; see [TODO](../TODO.md).

---

## Image, video, and audio

Media becomes a Markdown **write-up** first, then goes through the text index above. Write-ups are on demand: import does not run them, and the Agent or the user asks for one file. No sidecar `.md` is written into the library (it would be another asset).

Rules shared by all three:

- Loom is only an HTTP client; no model runs in-process. Local is a server the user runs, remote adds an API key, and endpoints are user-configured with no built-in default vendor; see [SETTINGS.md](../SETTINGS.md).
- The write-up is folded into fixed Markdown and handed to the Embedding slot. If that slot is empty, the text still stays.
- Invalidation is the same mtime rule as Level 1. Rename/move does not rerun. Changing the VLM or Audio model invalidates the write-up; changing the embedding model invalidates the chunk vectors.

### Images

- **VLM slot:** OpenAI-compatible `POST {requestUrl}`; the user message includes `image_url` (a data URI for a local file).
- **Output:** caption and tags; visible text in the image may go into the write-up.

```markdown
## Caption
...
## Tags
...
```

### Video

Same VLM slot as images. One Markdown write-up per file.

1. **Native video** when the endpoint accepts it: `POST /v1/chat/completions` with a `video_url` data URI (files up to 32 MB). Models such as Qwen3-VL can do this. A 400/413/415/422/5xx from native is remembered per endpoint+model for the process, then frames are used.
2. **Frames as `image_url`** when native is skipped or rejected: FFmpeg extracts 1–3 temp JPEGs (about 10% / 50% / 90% of duration; fewer for short clips). They are not library assets.

Scene chunks, per-shot captions, and soundtrack understanding wait. The longer-term unit is a segmented index, not one vector for the file:

```
video.mp4
├── file-level write-up                            (now)
├── Scene 1    00:00-00:08   caption + embedding   (later)
├── Scene 2    00:08-00:21   caption + embedding   (later)
└── transcript chunks                              (later)
```

“Find the shot where the person gets out of the car” would then locate `video.mp4  01:13 - 01:18` and call `extract_clip`. That tool chain does not exist yet.

### Audio

Standalone audio files. A separate Audio slot, not the VLM slot (which is vision-only): one model that describes music and ambient sound and transcribes speech when there is any.

- **Wire:** OpenAI-compatible `POST {requestUrl}`; the user message includes an audio part. LM Studio cannot take audio on `/v1/chat/completions`, and Qianfan compatible chat has no audio part. Hosted Qwen-Omni is DashScope compatible-mode (`input_audio.data` as `data:;base64,...` + `modalities: ["text"]` + `stream: true`); DashScope-looking URLs send Omni first. Other URLs try `audio_url`, then `input_audio`, then Omni.
- **Size:** FFmpeg converts locally when the file is not a form the endpoint accepts. Data URI up to 32 MB; over that, compact to 16 kHz mono MP3. DashScope's encoded-audio cap is 10 MB. Video soundtracks will reuse this slot.
- **Store:** `audio_writeup` keyed by `asset_id`; Details shows the caption, `describe_audio` writes it, `embed_asset` folds it into `text_chunks`.

```markdown
## Caption
...
## Tags
...
## Transcript
... only if there is speech ...
```

### What an index of a media file is

- A short caption is one parent with one child. Checked: a two-line caption with tags gives 1 parent, 1 child; a 17,000-character write-up gives 2 parents, 8 children. For a typical image the best passage is the whole caption.
- A hit returns the write-up text, not anything from the pixels or the audio. A detail the description left out cannot be found.
- Simple search also covers the write-up, so a word in a caption finds the file without an index.
- Index freshness follows the write-up: one saved after the index was built, or no longer matching the file's modified time, makes the index stale.
- Chunk offsets point into the write-up Markdown. Video and audio hits carry no time range yet.
- Describing and indexing are two steps in the core; only the app joins them (the Describe button, and the Agent's `describe_*` then `embed_asset`).

---

## Deep search

`deep_search_assets` searches **chunks** only:

- **Vectors:** embed the query once through the Embedding slot (`POST /v1/embeddings`), then sqlite-vec (or JS cosine) over **child** chunks that have embeddings.
- **Full text:** `chunks_fts` ranks child chunks by `bm25`. Chinese, Japanese, and Korean are cut into words first; see [below](#chinese-japanese-and-korean).
- **Filters:** type, property, tag, and favorite filters are a hard AND on both lists before fusion. Simple search takes the same filters. A file must have every tag named, and a name that is not a tag matches nothing.
- **Fuse:** the two ranked **chunk** lists with **RRF** (`score = Σ 1/(60 + rank)`, rank starts at 1). A chunk found by only one list still scores from that list. Keep each file's best chunk.
- **Rerank:** if the Rerank slot is on, the chunk texts go to the reranker before the limit; the document is always chunk text, never a filename. Cohere/Jina/Qianfan use `POST /v1/rerank` (or `/v2/rerank`). Bailian `qwen3-rerank` uses `POST .../compatible-api/v1/reranks`; a DashScope Chat URL is rewritten. An empty slot, one row, or a failure keeps the fused order. Rows that rerank or the limit drop are not added back. TEI-native `texts` waits.
- **Result:** one best **passage + `asset_id`** per file, with the parent passage for context, and `indexedCount`. No query text lists the library by the filters only. No Embedding slot, or a failed query embed, is full text only.
- A file with no index is invisible to deep search; the Agent uses `search_assets` for it. `indexedCount` tells it how many files deep search can see.

Minimal eval: `packages/core/tests/deep-search.test.ts` (full text only, vectors only, RRF + property AND, optional rerank, `indexedCount`, Chinese) and `packages/core/tests/fts-store.test.ts` (chunk full text, triggers, rebuild). Gold-set Recall@k / nDCG: `packages/core/evals/`. Plan: [EVALS](../agent/EVALS.md).

---

## Search design

### Why two searches

Full text used to be one row per file and vectors one row per chunk, so fusion squashed both to files, and a file hit only by full text had no passage for rerank to read. One tool also mixed a free keyword search with a paid semantic one, so the Agent could not choose. Now deep search works on chunks only and adds no file-level full text; a file that is not indexed is found with simple search.

Three layers of data, each with one job:

| Layer | Content | Limit | Used for |
|---|---|---|---|
| Original | file on disk | none | source of truth |
| Extract | `asset_metadata.data.text` | 256 KiB | Details preview, simple search |
| Chunks | `text_chunks` + `chunks_fts` | first 1 MiB of the file | vector search, deep search |

The index reads the original file itself, not the extract, so the extract's limit does not cap what is indexed.

### Chinese, Japanese, and Korean

None of FTS5's built-in tokenizers split Chinese by character or by word (`unicode61`, `ascii`, and `porter` treat a run of Chinese as one word; `trigram` needs at least 3 characters; `icu` is not available in this SQLite), so searching 天气 would not find 今天天气很好. Loom segments with `Intl.Segmenter("zh", { granularity: "word" })` and hands the result to `unicode61`:

- On write, each CJK run is cut into words and joined with spaces (`今天天气很好` → `今天 天气 很好`). English and digits are untouched. Both `assets_fts` and `chunks_fts` use this.
- On query, the same function cuts each CJK run, and each run becomes one phrase (`"人工 智能"`) so order and adjacency hold. Other words stay `"word"*`, all ANDed.
- The tokenizer is its own module (`retrieval/tokenize.ts`), shared by the store and the query.
- The full-text format version (tokenizer version plus the runtime's ICU version) is stored in `library_meta.fts_format`. A mismatch on open rebuilds both tables, so a later tokenizer change or an Electron upgrade needs no extra step.

Measured on real FTS5 with this machine's Chinese documents (22,682 paragraphs, about 4.2 million characters, 37% Han):

| Approach | Index size | Whole-word search: recall | Whole-word search: precision | Any-fragment search: recall |
|---|---|---|---|---|
| None | 19.7 MB | 0.30 | 1.00 | 0.20 |
| Per character + phrase | 24.8 MB (+26%) | 1.00 | 0.999 | 1.00 |
| **`Intl.Segmenter`** | **20.7 MB (+5%)** | **0.97** | **1.00** | **0.42** |
| Segmenter + sub-words of long words | 20.9 MB (+6%) | 0.98 | 1.00 | 0.43 |

"Whole word" queries are 2 to 4 character words taken from the text with the Segmenter; "any fragment" queries are random 2 to 4 character substrings, which often cross word boundaries.

What this costs:

1. **Search by word, not by arbitrary fragment.** A fragment that crosses words (such as 气很好) is missed about half the time. Real users rarely type those, but a piece of a filename or of a proper noun is affected. If searching by fragment turns out to be common, fall back to per-character splitting.
2. **A short word inside a long word may be missed.** `研究生院` is cut into `研究生 / 院`, so searching 研究 does not find it. Adding sub-words barely helps (0.97 → 0.98), so it is not done.
3. **It depends on the runtime's ICU version.** Electron 38 (ICU 74.2) and Node 26 (ICU 78.3) cut six sample sentences identically, but rare words and proper nouns may differ; the format version above covers this by rebuilding.
4. **Japanese and Korean use the Chinese dictionary.** They are split, not necessarily well, and Japanese often comes out as single kana. Using `ja` and `ko` would be more accurate and is not done.
5. **The first open after the upgrade rebuilds both tables.** On a synthetic library of 2,062 files and 22,682 child chunks this took about 1.4 s, then about 50 ms to open normally. The rebuild runs on the open path, so a library ten times larger may take over ten seconds; if that matters, run it in the background and keep the old table until it finishes.

Other approaches considered: `trigram` (a two-character word is not found), overlapping pairs (bigger, and a single character is not found), a segmentation library with its own dictionary (independent of ICU, but a large dictionary and packaging cost), a custom FTS5 tokenizer extension (native code to build and ship on every platform).

### Search does not follow relations

Search used to add each candidate's linked files one hop out. It no longer does: neither search returns `linkedFrom` rows, and the Agent calls `inspect_asset` to see a file's relations. The relations themselves (graph view, Details, `create_relation`, `remove_relation`) are unchanged.

- The cost: finding neighbors takes one more call per hit, and a file related only through a relation, with no textual similarity (a source video whose caption never says "poster"), no longer shows up in search by itself.
- If it is needed later: a `related_assets(assetId)` tool that returns neighbors in one call, or an `includeRelated` switch on `deep_search_assets`, off by default.

### Risks and unverified

- Chunking is synchronous at about 2 s per MiB, so a 1 MiB file can stall the main process for about 2 s. A worker or yielding in slices can come later.
- A JSON file over 1 MiB fails to parse after the cut, falls back to plain text, and is not flattened to `path: value`.
- Not verified: how segmenting Chinese filenames and paths changes existing ranking; how well Japanese and Korean segment; the measurements used one technical, mixed Chinese and English corpus, so literature, news, and chat logs may differ.

---

## Enrichment levels

Asset understanding deepens incrementally. Users control both scope and cost. **Not every file deserves AI analysis.** Users explicitly choose which assets receive embeddings or semantic analysis, avoiding uncontrolled API spending at import time.

```
Level 0  Filesystem metadata         Free
   ↓
Level 1  FFprobe / EXIF / text       Local compute
   ↓
Level 2  Embedding                   Optional
   ↓
Level 3  VLM semantic understanding  Optional, may cost money
   ↓
Level 4  Deep analysis               Optional
```

| Level | Content | Cost | Trigger |
|---|---|---|---|
| 0 | Filesystem metadata: path, size, hash, mtime, type | Free | Automatic on import |
| 1 | FFprobe (duration/resolution/codec), EXIF, text extraction | Local compute | Automatic |
| 2 | Chunked Markdown embeddings; image / video / audio become text first, then chunk; see [Image, video, and audio](#image-video-and-audio) | Optional, HTTP provider (local server or remote API key) | User-selected |
| 3 | VLM writes captions / tags for images, and file-level video (native video or frames); Audio slot writes file-level audio | May cost money | User-selected |
| 4 | Deep analysis: segmentation, quality scoring, style tags, and more | May cost money | User-selected |

- Level 1 writes `asset_metadata` keyed by `asset_id`. Common invalidation columns stay fixed; per-type fields are a `kind` JSON payload (`image` / `video` / `audio` / `text`).
- Level 1 is extracted from the file on disk. Missing, failed, or stale rows refresh after open and reconcile. Rename/move of a ready row does not.
- Level 2/3/4 outputs stay in SQLite (vectors, FTS, and metadata); see PRODUCT.md Section 3.2.

---

## Library job lifecycle

Each library opening owns a task scope. Switching or closing stops admission and the watcher, cancels jobs, drains storage writes and media cleanup, then closes storage. Queued jobs do not start after cancellation; late provider output cannot publish into another opening. Opening recovers interrupted description/embedding records as retryable failures. Detail reads and action results are checked against the current opening, selection, and request.

Image, video, and audio descriptions compose the shared `rag/description.ts` workflow and `model/description.ts` record/status types. Each media service retains its own serial queue and input preparation; the shared workflow handles cache freshness, transitions, failures, and notifications. LocalCore continues to bind jobs and notifications to the current library task scope.
