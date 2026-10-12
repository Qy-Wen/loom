[English](./EVALS.md) | **简体中文**

# 评测

> Loom 怎么评 Agent 行为、工具调用和检索。Agent 运行时见 [AGENT.md](./AGENT.zh-CN.md)。Hybrid Search 见 [TEXT.md](../RAG/TEXT.zh-CN.md)。模型槽位见 [SETTINGS.md](../SETTINGS.zh-CN.md)。待办见 [TODO.md](../TODO.zh-CN.md)。
>
> 这里只记结论。

---

## 1. 范围

金标放在本仓库，跟被测代码在一起。不另开评测仓库。第一版不用 LangSmith，也不用 LLM-as-judge。

三条线：

| 线 | 评什么 | 代码 |
|---|---|---|
| 运行时 | 压缩、prompt-cache | `packages/agent/evals/compaction-*.ts`、`prompt-cache-hit.ts` |
| Agent / 工具 | 该调哪些、不该调哪些 | `packages/agent/evals/tasks.ts` |
| 检索 | query → 库内相对路径 | `packages/core/evals/` |

Hybrid Search 单测（`packages/core/tests/hybrid-search.test.ts`）保留。它查 FTS / 向量 / RRF / 属性 AND / 可选 rerank 的接线，不是检索质量金标。

---

## 2. 运行时

- **压缩率：** 压缩后 / 压缩前的上下文 token。越小说明丢掉越多。`compaction-rate.ts` 用确定性 faux 摘要器执行原生 durable compaction task，使用 pi-ai 消息 token 估算。真实阈值压缩是 `eval:compaction-e2e`，前后数值也是估算，并非 provider usage。
- **Prompt-cache 命中率：** Chat usage 的 `cacheRead / (input + cacheRead + cacheWrite)`（接口 `prompt_tokens` 拆开后）。命令是 `eval:prompt-cache-hit`。

现场 Chat 读 `.env`：`DEEPSEEK_API_KEY`，可选 `LOOM_CHAT_BASE_URL` 和 `LOOM_CHAT_MODEL`（默认 DeepSeek 地址和 `deepseek-v4-flash`）。不读设置页文件。

---

## 3. Agent / 工具

金标在 `tasks.ts`。每一行是一轮用户消息：

- `expectTools` / `forbidTools`
- 可选 `argIncludes`（对工具参数做正则）
- 可选 `answerIncludes`
- 可选 `selection`（`ui_selection`：`assetId`、库内相对 `path`、`assetType`）
- 可选 `chips`（输入框 `asset_ref` 附件，字段相同）

当前任务：`search-river`（必须 `search_assets`，不要 bash/write/edit）、`inspect-selection`（必须对库高亮 `inspect_asset`，不要再 search/bash/write/edit）、`inspect-chip`（输入框 `asset_ref` 芯片同样规则）、`chitchat`（回答里有 `4`，不要库工具或工作区工具）。

打分在 `agent-score.ts`：看父/归属子会话的 durable `tool_execution_start` 事件和已提交 assistant 正文。缺了该调的、调了禁止的、参数没对上、回答缺关键字，都算失败。

| Runner | 命令 | Chat |
|---|---|---|
| CI 假 Chat | `eval:agent-tools` | 脚本化 HTTP Chat。不联网。 |
| 现场 | `eval:agent-tools:live` | `.env` 里的真实 Chat 槽位。有一条失败就退出。 |

现场 harness 会打开一份临时库，文件和检索金标相同；系统提示对齐产品：`search_assets` / `inspect_asset`、`<asset_ref>` / `<system-reminder>` / `<ui_selection>`，已经点名的库文件不要用 bash/write/edit 去查。空库、或系统提示里没有这些块，不能当 Agent 评测。

---

## 4. 检索

金标是 query → **库内相对路径**。不存 `assetId`。`k = 3`。指标是 Recall@k 和 nDCG@k（`metrics.ts`），二元相关。

语料在 `library.ts`：二十来篇短 Markdown，按车 / 食物 / 品牌 / 镜头 / 账单分簇，并放近义干扰项（摩托车对自行车、番茄沙拉对汤、报价对发票）。查询在 `qrels.ts`，用 id 前缀分组：

- `fts-*` — 文件名或正文里的关键词。多数一条金标；`fts-tomato` 两条。
- `semantic-*` — 同义转述。查询和金标正文不能共享实词（长度 ≥ 4，去掉停用词）。CI 假向量仍可用查询侧同义词对齐到同一轴。
- `prop-*` — 查询加上 Status 的 AND 过滤；同一 Status 上另有干扰文件。

| Runner | 命令 | Embed |
|---|---|---|
| CI | `eval:retrieval` | 关键词轴假 `EmbeddingProvider`。平均 Recall@3 必须是 1。 |
| 现场 | `eval:retrieval:live` | `.env` 里的 OpenAI 兼容 `POST /v1/embeddings`。 |

现场环境变量：`LOOM_EMBED_BASE_URL`、`LOOM_EMBED_MODEL`、可选 `LOOM_EMBED_API_KEY`。报文和 Embedding 槽位一样。不读设置页。报告按 FTS / semantic / property 分开算平均 Recall。**semantic** 平均 Recall@3 低于 **0.5** 则失败。现场不要求 100%。这条 runner 不跑 rerank。一次最多 embed 8 条（托管槽位常见上限 10–16）。

---

## 5. 命令

```bash
pnpm --filter @loom/agent eval:compaction-rate
pnpm --filter @loom/agent eval:prompt-cache-hit
pnpm --filter @loom/agent eval:compaction-e2e
pnpm --filter @loom/agent eval:agent-tools
pnpm --filter @loom/agent eval:agent-tools:live
pnpm --filter @loom/core eval:retrieval
pnpm --filter @loom/core eval:retrieval:live
```

CI：假 Chat 的 Agent 任务、假向量检索、Hybrid Search 单测、指标单测。现场脚本可选，需要 `.env`。

## 6. Durable 迁移基线

- 离线原生压缩：估算 4246 → 460 token（10.8%），替换 29 条消息，保留 3 条。
- DeepSeek `deepseek-v4-flash` 阈值压缩：产生一份摘要，估算 39499 → 14388 token。摘要保留 code/path，回忆返回 `LOOM-7F3K`、`projects/aurora/main.mp4`、`teal`。
- Prompt-cache：同选区平均 60.0%（0.0%、80.2%、99.7%），换选区平均 99.8%。第二组复用了已热的前缀，不能把均值作为选区变化的受控对比。
- 假 Chat 工具金标 4/4；最近一次 live 为 3/4，`inspect-chip` 直接 `read` 而未执行要求的 `inspect_asset`。修正了 mock 返回错误素材路径的问题，没有放宽金标；该行为/能力差距仍未关闭。
- Electron 测试实际打开临时库，覆盖子审批、reload/fork、SIGKILL/重开恢复，以及模型流仍未结束时文字已显示。Live 计时只统计 `/run`，不计空闲 connect 的结束事件。可选 `e2e/live-chat.spec.ts` 也用真实 DeepSeek 验证了 `RUN_FINISHED` 前正文可见。

尚不宣称完整新旧能力等价：Windows 运行时、更多崩溃点（流式生成/正在执行外部工具）的覆盖待完成。Telemetry 不在本次迁移范围。