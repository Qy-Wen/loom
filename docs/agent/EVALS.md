**English** | [简体中文](./EVALS.zh-CN.md)

# Evals

> How Loom scores Agent behavior, tool use, and retrieval. Agent runtime: [AGENT.md](./AGENT.md). Hybrid Search: [TEXT.md](../RAG/TEXT.md). Model slots: [SETTINGS.md](../SETTINGS.md). Roadmap: [TODO.md](../TODO.md).
>
> Record conclusions here.

---

## 1. Scope

Gold lives in this repo, next to the code it scores. Do not open a second eval repository. Do not use LangSmith or LLM-as-judge in v1.

Three tracks:

| Track | What it scores | Code |
|---|---|---|
| Runtime | Compaction and prompt-cache | `packages/agent/evals/compaction-*.ts`, `prompt-cache-hit.ts` |
| Agent / tools | Expected and forbidden calls | `packages/agent/evals/tasks.ts` |
| Retrieval | Query → library-relative paths | `packages/core/evals/` |

Hybrid Search unit tests (`packages/core/tests/hybrid-search.test.ts`) stay. They check FTS / vector / RRF / property AND / optional rerank wiring. They are not the quality gold set.

---

## 2. Runtime

- **Compaction rate:** context tokens after compact / tokens before. Smaller means more was dropped. Offline formula in `compaction-rate.ts`. Live threshold compaction is `eval:compaction-e2e`.
- **Prompt-cache hit rate:** `cacheRead / (input + cacheRead + cacheWrite)` from Chat usage (the API `prompt_tokens` split). `eval:prompt-cache-hit`.

Live Chat reads `.env`: `DEEPSEEK_API_KEY`, optional `LOOM_CHAT_BASE_URL` and `LOOM_CHAT_MODEL` (defaults: DeepSeek URL and `deepseek-v4-flash`). Not the Settings file.

---

## 3. Agent / tools

Gold tasks in `tasks.ts`. Each row is one user turn:

- `expectTools` / `forbidTools`
- optional `argIncludes` (regex on tool args)
- optional `answerIncludes`
- optional `selection` (`ui_selection`: `assetId`, library-relative `path`, `assetType`)
- optional `chips` (composer `asset_ref` attachments, same fields)

Current tasks: `search-river` (must `search_assets`, no bash/write/edit), `inspect-selection` (must `inspect_asset` on the library highlight, no extra search/bash/write/edit), `inspect-chip` (same for a composer `asset_ref` chip), `chitchat` (answer includes `4`, no library or workspace tools).

Scoring is in `agent-score.ts` over `tool_start` events plus concatenated `text` deltas. Fail on any missing expected tool, forbidden hit, arg miss, or answer miss.

| Runner | Command | Chat |
|---|---|---|
| CI stub | `eval:agent-tools` | Scripted HTTP Chat. No network. |
| Live | `eval:agent-tools:live` | Real Chat slot from `.env`. Fail if any task fails. |

The live harness opens a temp library with the retrieval gold files, and uses a system prompt that matches product: `search_assets` / `inspect_asset`, `<asset_ref>` / `<ui_selection>`, no bash/write/edit to look up an already identified library file. Empty library or a prompt that omits those blocks is not a valid Agent eval.

---

## 4. Retrieval

Gold is query → **library-relative paths**. Do not store `assetId`. `k = 3`. Metrics: Recall@k and nDCG@k (`metrics.ts`), binary relevance.

Corpus in `library.ts`: two dozen short markdown files in tight clusters (bike / food / brand / clip / billing) plus near-synonym distractors (motorcycle vs bicycle, tomato salad vs soup, quote vs invoice). Queries in `qrels.ts`, grouped by id prefix:

- `fts-*` — keyword in filename or body. Some queries have one gold path; `fts-tomato` has two.
- `semantic-*` — paraphrase. Query and gold file must not share content words (length ≥ 4, stopwords dropped). CI fake embed may still map query-side synonyms onto the same axis.
- `prop-*` — query plus a Status AND filter, with another file on the same Status as a distractor.

| Runner | Command | Embed |
|---|---|---|
| CI | `eval:retrieval` | Keyword-axis fake `EmbeddingProvider`. Mean Recall@3 must be 1. |
| Live | `eval:retrieval:live` | OpenAI-compatible `POST /v1/embeddings` from `.env`. |

Live env: `LOOM_EMBED_BASE_URL`, `LOOM_EMBED_MODEL`, optional `LOOM_EMBED_API_KEY`. Same wire as the Embedding slot. Do not read Settings. Report mean Recall by FTS / semantic / property. Fail if **semantic** mean Recall@3 is below **0.5**. Do not require 100% on live. Do not run rerank in this runner. Embed requests batch at most 8 texts (hosted slots often cap at 10–16).

---

## 5. Commands

```bash
pnpm --filter @loom/agent eval:compaction-rate
pnpm --filter @loom/agent eval:prompt-cache-hit
pnpm --filter @loom/agent eval:compaction-e2e
pnpm --filter @loom/agent eval:agent-tools
pnpm --filter @loom/agent eval:agent-tools:live
pnpm --filter @loom/core eval:retrieval
pnpm --filter @loom/core eval:retrieval:live
```

CI: stub Agent tasks, fake-embed retrieval, Hybrid Search unit tests, metric unit tests. Live scripts are optional and need `.env`.