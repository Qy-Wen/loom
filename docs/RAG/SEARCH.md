**English** | [简体中文](./SEARCH.zh-CN.md)

# Search and Index Refactor Plan

> Status: all three steps are implemented. Current behavior: [TEXT.md](./TEXT.md), [RAG.md](./RAG.md), [SCHEMA.md](./SCHEMA.md). This page keeps the decisions and their reasons.
>
> Where it differs from the plan: `MetadataStore` also gained `countIndexedAssets()` for `indexedCount`; `searchAssets` no longer takes Embedding or Rerank providers (it uses no model); deep search's fusion and "best chunk per file" live in `retrieval/deep.ts`.

---

## Problems

1. **Mismatched units.** Full-text search is one row per file; vector search is one row per chunk. Fusion and rerank squash both to files. A file hit only by full-text has no passage, so rerank sees just its filename.
2. **The vector index borrows the extract.** The extract exists for preview and full-text search. Because indexing reads it, the extract's limit also caps what the index covers.
3. **One tool, two jobs.** `search_assets` mixes a free local keyword search with a semantic search that calls embedding and rerank. The Agent cannot choose.
4. **Chinese search is broken.** FTS5 `unicode61` treats a run of Chinese as one word, so searching 天气 does not find 今天天气很好.

## Target structure

| | Simple `search_assets` | Deep `deep_search_assets` |
|---|---|---|
| Unit | file | chunk |
| Source | `assets_fts`: filename, path, properties, extract, caption | chunk full-text + chunk vectors |
| Fusion | none, one ranking | RRF over chunks only |
| Rerank | none | yes, input is always chunk text |
| Coverage | every file | indexed files |
| Models | none | Embedding and Rerank optional |

Three layers of data, each with one job:

| Layer | Content | Limit | Used for |
|---|---|---|---|
| Original | file on disk | none | source of truth |
| Extract | `asset_metadata.data.text` | 256 KiB | Details preview, simple search |
| Chunks | `text_chunks` + chunk full-text | first 1 MiB of the file | vector search, deep search |

Deep search looks only at chunks and does not add file-level full-text. Files that are not indexed are found with simple search.

No backward compatibility: `search_assets` becomes simple-only outright, with no alias and no transition flag.

## When chunking happens

Chunking and vectors go together. They happen only when the user clicks Embed, the Agent calls `embed_asset`, or an image / video / audio write-up finishes and indexing follows. Importing and opening a library do not chunk.

- Why: synchronous chunking takes about 2 s per MiB, too heavy to run over a whole library on its own; vectors call an external API and cost money, so the user must ask for them.
- Result: a file that was never embedded has no chunks and deep search cannot see it; use simple search. Without an Embedding model no chunks are built, so deep search is unavailable.
- Later option: split "chunks + chunk full-text" from "vectors". The first runs in the background after the extract and needs no model; the second stays manual. It needs a background task that can be cancelled and yields to the event loop first; see [TODO](../TODO.md).

## Media files: the chunks are the write-up

An image, video, or audio file has no text of its own, so the index reads its write-up instead (the caption or description produced by the VLM or Audio slot). That Markdown goes through the same `chunkMarkdown` as a text file, so chunks, vectors, and chunk full-text work the same way and deep search treats them alike.

- A short caption is usually one parent with one child chunk. Checked: a two-line caption with tags gives 1 parent, 1 child; a 17,000-character write-up gives 2 parents, 8 children. So for a typical image, "the best passage" is the whole caption.
- A hit on a media file returns the write-up text, not anything from the pixels or the audio. Deep search can only find what the model wrote down, so a detail the description left out cannot be found.
- Simple search also covers the write-up: it is part of the file-level text, so a word in a caption finds the file without an index. Deep search needs the file to be indexed; the write-up alone is not enough.
- Index freshness follows the write-up. If the write-up was saved after the index was built, or no longer matches the file's modified time, the index counts as stale and the next index rebuilds the chunks from the current write-up.
- Chunk offsets point into the write-up Markdown, not into the media file. Video and audio hits carry no time range yet; cutting by time is a later option.
- Describing and indexing stay two steps in the core. Only the app joins them: the Describe button, and the Agent's `describe_*` followed by `embed_asset`.

## Step 1: the index reads the original file

- `TextEmbedService` stops depending on `EnrichmentService`. It takes an injected `resolvePath`; `LocalCore` passes `library.getAssetFilePath`.
- New constant `TEXT_INDEX_LIMIT = 1 MiB` (bytes) in `model/text-embed.ts`. Read the first 1 MiB and cut on a UTF-8 boundary.
- The truncation notice is `asset.size > TEXT_INDEX_LIMIT`. No new database column.
- `TEXT_ENRICHMENT_LIMIT` returns to 256 KiB, `ENRICHMENT_VERSION` returns to 1, and `TEXT_SEARCH_LIMIT` is removed.
- A cut CSV drops its last row and a cut JSON falls back to plain text, as today.
- Tests: about eight `new TextEmbedService(...)` calls move to the new signature and use real files in a temp directory.
- Docs: update the input source and both limits in `TEXT` and `SCHEMA`, both languages.

## Step 2: chunk full-text and Chinese tokenizing

- Add an FTS5 table with one row per **child chunk**, covering the same chunks as the vectors.
- Keep it in sync with a trigger: deleting a child from `text_chunks` deletes its FTS row. Verified: `ON DELETE CASCADE` removing rows does **not** clean an FTS table by itself, but it does fire an `AFTER DELETE` trigger. So removing an asset or replacing its chunks leaves nothing behind, and there is no need to check `removeAsset`, `replaceAssets`, and `upsertAsset` one by one.
- Rank with FTS5's own `bm25`; use `snippet` when a fragment is needed.
- Existing libraries: on open, if the chunk full-text row count differs from the child chunk count, backfill from `text_chunks`.
- Interface: `MetadataStore` gains `searchChunksFts(query, limit)`, in both the SQLite and in-memory stores. `NearestChildHit` becomes `ChunkHit`, shared by full-text and vector search.

### Chinese tokenizing

None of FTS5's built-in tokenizers split Chinese by character or by word (`unicode61`, `ascii`, and `porter` treat a run of Chinese as one word; `trigram` needs at least 3 characters; `icu` is not available in this SQLite). The plan is to **segment with `Intl.Segmenter` first and hand the result to `unicode61`**, not to swap the tokenizer (decided):

- On write: run each stretch of CJK text through `new Intl.Segmenter("zh", { granularity: "word" })`, keep the `isWordLike` segments, and join them with spaces (`今天天气很好` → `今天 天气 很好`). English and digits stay as they are, so `unicode61` works unchanged.
- On query: the same function segments each CJK run in the query, and each run becomes one phrase (`"天气"`, `"人工 智能"`) so the order and adjacency hold. Other words stay `"word"*`, all ANDed.
- The tokenizer is its own module, shared by the store and the query. One Segmenter instance is reused.
- Japanese and Korean go through the same function. Segmenting them with `ja` and `ko` would be more accurate, but this change uses `zh` for everything (not verified for Japanese and Korean beyond the fact that they are split).
- **File-level full-text `assets_fts` uses the same function** (decided).
- **A version number triggers the rebuild.** Today `assets_fts` is rebuilt only when the `assets` and `assets_fts` row counts differ; a new tokenizing rule leaves the counts equal and would not trigger it. So the library stores a "full-text index format version" (SQLite `PRAGMA user_version` or a small table). On open, a lagging version rebuilds `assets_fts`, backfills chunk full-text, and writes the new version. Any later tokenizer change uses the same mechanism.
- Tests: whole words, a word inside a longer word, mixed Chinese and English, word order, a Chinese filename; old text is gone after a chunk is replaced or an asset is removed; backfill; a library with an old version is rebuilt on open and one already at the latest version is not rebuilt again.

### Consequences of the Chinese tokenizing

Measured on real FTS5 with this machine's Chinese documents (22,682 paragraphs, about 4.2 million characters, of which 1.55 million are Han characters, 37%):

| Approach | Index size | Whole-word search: recall | Whole-word search: precision | Any-fragment search: recall |
|---|---|---|---|---|
| None (today) | 19.7 MB | 0.30 | 1.00 | 0.20 |
| Per character + phrase | 24.8 MB (+26%) | 1.00 | 0.999 | 1.00 |
| **`Intl.Segmenter` (this plan)** | **20.7 MB (+5%)** | **0.97** | **1.00** | **0.42** |
| Segmenter + sub-words of long words | 20.9 MB (+6%) | 0.98 | 1.00 | 0.43 |

"Whole word" queries are 2 to 4 character words taken from the text with the Segmenter; "any fragment" queries are random 2 to 4 character substrings, which often cross word boundaries.

What this plan costs:

1. **Search by word, not by arbitrary fragment.** A whole-word search is almost as good as per-character splitting; a fragment that crosses words (such as 气很好) is missed about half the time because the index has no such string. Real users rarely type those, but "a piece of a filename" or "part of a proper noun" is affected.
2. **A short word inside a long word may be missed.** `研究生院` is cut into `研究生 / 院`, so searching 研究 does not find it. Adding sub-words of long words barely helps (0.97 → 0.98), so it is not done.
3. **The index is only about 5% bigger than today.** English, code, and punctuation are unaffected. The earlier "3.8 times" estimate came from synthetic all-Chinese text and was too high; real documents are only about 37% Han characters.
4. **High precision.** It does not match a cross-word pair that merely sits side by side, like the pair inside 大天气.
5. **It depends on the runtime's ICU version.** The cuts come from the ICU dictionary. Electron 38 (ICU 74.2) and Node 26 (ICU 78.3) cut six sample sentences identically, but versions may differ on rare words and proper nouns. After an Electron upgrade, an old index and a new query could disagree. Remedy: fold the ICU version (`process.versions.icu`) into the full-text index format version, so a change rebuilds.
6. **A one-time rebuild.** The first open after the upgrade rebuilds `assets_fts` (empty it, then rebuild each file's filename, path, properties, extract, and caption and write it back), and chunk full-text is backfilled for indexed files. With many files or long text this takes a while, it happens on the open path, and search is unavailable or incomplete meanwhile. Segmenting itself is fast (about 19 ms for 175,000 characters).
7. **Japanese and Korean** use the Chinese dictionary: they are split but not necessarily well, and Japanese often comes out as single kana.
8. **An incompatible storage change.** The old `assets_fts` contents do not match the new tokenizing and must be rebuilt; an older version reading the new table will match wrongly.

Alternatives and why not:

- Per-character splitting: the most stable recall and no ICU dependency, but about +26% index size and it matches cross-word neighbors (precision 0.97). Not chosen now; if searching by fragment turns out to be common, fall back to it.
- `trigram`: two-character words are not found.
- Overlapping pairs (bigram): bigger, and a single character is not found.
- A segmentation library (dictionary shipped with the app): cuts independent of the ICU version, but the dictionary is large, with packaging and signing cost.
- A custom FTS5 tokenizer extension: needs native code to compile, with cross-platform packaging cost.

## Step 3: split search, tools, prompt, docs

- **core**: split `searchLibrary` into two methods.
  - `searchAssets`: file-level full-text plus type and property filters. With no query it still lists. Vector, RRF, rerank, and relation expansion are removed.
  - `deepSearchAssets`: chunk full-text + chunk vectors → RRF → filter → rerank chunk text → best chunk per file → limit. With no Embedding slot it runs on full-text alone.
  - Returns `indexedCount`. When it is 0 the Agent knows to use simple search or build the index first.
- **Tools**: `search_assets` becomes the simple search; add `deep_search_assets`. The embedding and rerank providers go only to deep search.
- **Prompt and refs**: `agent-prompt.ts` says when to use which; `asset-refs.ts` makes both tool names produce clickable refs; confirm `run_retrieve_agent`'s tool set includes both (where it is assembled is not yet found).
- **Remove relation expansion** (decided): search no longer walks one relation hop, and neither search has `linkedFrom` rows.
  - Delete: `retrieval/graph.ts` (`expandSearchCandidates`, `SEARCH_NEIGHBORS_PER_SEED`); `linkedFrom` and `SearchLink` in `model/retrieval.ts` and the export in `core/src/index.ts`; the call in `local-core.ts`; the sentences about `linkedFrom` and relations in the `asset-tools.ts` tool description; the "search row has linkedFrom" sentence in the retrieve specialist prompt in `packages/agent/src/extensions/specialist.ts`.
  - Keep: relations themselves (graph view, relations in Details, `create_relation` / `remove_relation`, the relations `inspect_asset` returns). To see neighbors, the Agent uses `inspect_asset`.
  - Add one sentence to the prompt: after a hit, when provenance matters, call `inspect_asset` on the important results to see their relations.
- **Tests**: delete `graph-retrieval.test.ts` (all five cases are relation expansion); adjust `hybrid-search`, `retrieval`, `asset-tools`, `agent-prompt`, `asset-refs` for the new tools; `core/evals/retrieval.ts` calls `deepSearchAssets`.
- **Docs**: `RAG`, `TEXT`, `SCHEMA`, `AGENT`, `PRODUCT`, both languages. In `PRODUCT` §3.3 "each candidate follows its relations one hop" becomes: the graph is for recording, browsing, and `inspect_asset`; the relation-expansion paragraph in `TEXT` is deleted.

## Open

None.

## Consequences of removing relation expansion

- One step less to find neighbors: a search used to return the hits and their neighbors together; now the Agent calls `inspect_asset` on each hit, and with many hits that means more calls.
- A file related only through a relation, with no textual similarity (for example a source video whose caption never mentions "poster"), no longer shows up in search by itself. Only an Agent that follows relations sees it, and vector or full-text search cannot replace that.
- The search side of the "Creative Asset Graph" in `PRODUCT` goes away; the graph is for recording and browsing.
- If it is needed later, add `related_assets(assetId)` to return neighbors in one call, or an `includeRelated` switch on `deep_search_assets`, off by default. Not done now.

## Risks and unverified

- Chunking is synchronous at about 2 s per MiB, so a 1 MiB limit can stall the main process for about 2 s. Not solved here; a worker or yielding in slices can come later.
- A JSON file over 1 MiB fails to parse after the cut, falls back to plain text, and is not flattened to `path: value`.
- Verified: the SQLite bundled in better-sqlite3 is 3.53.4 and has FTS5 `bm25` and `snippet`; a cascading delete fires an `AFTER DELETE` trigger.
- Measured: size and recall of the Chinese tokenizing, in "Consequences of the Chinese tokenizing"; `Intl.Segmenter` in Electron 38 and Node 26 cuts six sample sentences identically.
- Measured (this machine, synthetic data): a library of 2,062 files and 22,682 child chunks takes about 1.4 s to rebuild both full-text tables on the first open after the upgrade, then about 50 ms to open normally; chunk full-text is 19 MB and file-level 3 MB. The rebuild runs on open, so a library ten times larger may take over ten seconds; if needed, run it in the background and keep the old table until it finishes.
- Not verified: how segmenting Chinese filenames and paths changes the ranking of existing searches; how well Japanese and Korean segment; the corpus was one technical, mixed Chinese and English set, so literature, news, and chat logs may differ.

## Commit order

Each step is committed separately once its tests pass.
