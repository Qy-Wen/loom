**English** | [简体中文](./TRACE.zh-CN.md)

# Local Agent Traces

Development mode records traces and metrics in `<library>/.loom/agents/traces/telemetry.sqlite`. Traces expire 30 days after their last update; metric intervals expire 30 days after their start. Cleanup runs on open and every minute. The viewer pages the latest 40 conversations and loads 40 traces per conversation at a time; both lists can load earlier history. Its Metrics tab shows the latest 200 metric rows and refreshes every second while open. Switching libraries resets both views. Production builds do not record or include the trace window. No data is uploaded.

The old `traces.sqlite` is left untouched and is not read or migrated.

## Recording

- Pass `DurableTrace.telemetry` through `LibraryRuntime` to `HarnessOptions.telemetry`. Pi supplies submission/phase/request/poll instrumentation, events, metric updates, and persisted context propagation.
- `LiveTelemetry` implements the native adapter contract: span identities, timing, links, attributes, events, statuses, and metric aggregation. It persists unfinished spans for live display and crash diagnostics; native Chord SQLite stores only settled spans.
- `DurableTrace.models()` adds redacted input/output to the existing native request span. It creates no request spans and does not infer task identity from signals or checkpoints.
- Tool hooks add arguments. The commit content observer captures finalized model tool-result entries and nested program results, including blocked/interrupted diagnostics; it does not capture pre-limit `afterTool` results. `DurableTrace` derives submission summaries only from committed state and owns the viewer's status rules; the recorder does not interpret durable events. `ToolGate` records `loom.approval` around approval waits.
- Native input submissions are separate root traces. Specialist inputs link to their calling tool; the viewer shows those links. Nested tools use native parentage within a trace.
- SQLite WAL is independent of `.loom/agents/sessions/loom.sqlite`. Starts are saved before request dispatch; content updates coalesce at 100 ms and native settlement flushes. A diagnostic write failure disables recording while Chat continues.

After a crash, unfinished spans become `interrupted`. Native carriers reconnect recovered work to the same trace; interrupted attempts remain visible. Tracing never schedules or replays tools.

## Contents and privacy

Native metadata includes model/provider/API, stop reason, response ID, usage/cost, first-chunk events, phase outcomes, and bounded errors.

Counters, up-down counters, and histograms aggregate into ten-second intervals with count, sum, minimum, and maximum. Instrument options are copied at creation; description, unit, and supplied histogram boundaries are retained. Bucket counts are non-cumulative, include an overflow bucket, and merge across flushes and reopen. Histograms retain the latest eight exemplars per series/interval; clicking one opens its trace and selects its span. Expired references are reported as unavailable. Active-task measurements are deltas, not a current-task total. Older rows remain readable without backfilled metadata. Raw measurements are not persisted.

Input/output uses the existing redaction policy: known Chat secrets and credential patterns are removed; images, signatures, and headers are omitted. Requests keep the latest 200 messages, bounded to 32 KiB of encoded UTF-8 JSON per message. Ordinary payloads are bounded to 8 KiB. Finalized tool results are exempt from the second byte-size cut: Pi's output limits and spill previews remain unchanged, as do redaction and structural safeguards. Trace never reloads a full-output file. Previously clipped records remain unchanged. Long request strings retain a 600-character preview and deduplicated redacted full text capped at 4 MiB. Containers retain at most 200 fields/items with an omission notice; nesting beyond 12 levels is omitted. Clipping shortens values or omits fields without breaking JSON syntax.

Tool definitions are saved separately as `loom.io.tools` on each native request span; message captures retain addition names, not duplicate schemas. Pi resolves the registry from the full request's tool deltas before message paging. Each definition has an independent 4 MiB JSON budget, with up to 64 schema levels and 100,000 visited values; the registry and schema containers do not share the ordinary 200-item cap. Long descriptions use the same redacted blobs. Schema field names such as `headers`, `apiKey`, and `signature` remain intact; actual defaults/examples and known secrets are still redacted. Excessive definitions retain explicit omission notices. Old captures use their saved deltas and cannot recover lost content.

## Viewer

The conversation list groups traces by recorded conversation identity; unidentified historical roots stay separate. An indexed summary query avoids loading every payload to build the list. Native traces and spans are not merged or recreated.

The event ledger groups loaded traces into turns and shows system/context snapshots, user inputs, model replies, tool arguments → results, approvals, retries, and diagnostic phases. Request history is not repeated as new events. Input rows come from captured request snapshots; unavailable or malformed historical inputs are marked, not guessed. Turn/step numbering is local to loaded history; redundant request-number badges are omitted. Normal scheduling phases—including waiting, sleeping, and next-phase transitions—are hidden. Errors, interruptions, retries, and compaction have readable labels; a retried request does not repeat its scheduling phase as another event. All native spans remain available under Underlying execution records in raw details. Tool results—including JSON inside text blocks—use JSON trees when parseable. Other text uses a monospace plain-text view preserving spacing and line breaks, not Markdown.

The three-lane overview uses equal event widths by default; Duration switches to actual timing with parallelism and idle gaps. Snapshot inputs have no fabricated duration. Clicking a block selects its event; dragging focuses a range. Search and manual turn/call folding operate on the ledger. Live updates preserve selection and folds. Metrics and links navigate to the exact referenced span, including native spans hidden from the ledger.

Details provide Overview, Preview, and Raw tabs. Preview renders Markdown with a separate thinking section. The system-prompt body and tool list start expanded and fold independently; live updates preserve both states. Folding the tool list also preserves its internal JSON folds. In previews, untrusted HTML is escaped, and images/links cannot fetch remote content. Raw means the redacted, bounded capture, not a complete HTTP request. System-prompt details include a separate tool list with captured names, descriptions, and schemas, taken from the independent request snapshot or historical system-message tool deltas; omission markers within declarations or missing definition blobs trigger a warning, not clipped prompt text or earlier-message notices. Snapshot events show only their own captured fragment (and tool declarations for the system prompt), not the source request's entire message list or reply; source-call metadata and the expandable all-span inspection are labeled separately. JSON objects, arrays, and long strings default to fully expanded; only explicit clicks fold them. Manual folds survive live updates and parent folding. Older incomplete JSON records fall back to text.

Conversation/ledger and ledger/detail dividers can be dragged. Minimum sizes keep both panes usable; preferences survive tab changes and window reopen. Double-click resets a divider; focused dividers accept arrow keys and Home/End. No third-party trace UI or store is required.

This is best-effort redaction, not anonymization: prompts, memory, paths, and tool output can contain private information. The local database is not encrypted.

## Validation

Coverage includes the native adapter conformance suite with actual ordered measurement assertions, metadata copying, buckets/exemplars across flush and reopen, propagation/links, live and SIGKILL recovery, approvals, retry, deferred polls, compaction, diagnostic failure isolation, redaction, pagination, and 30-day cleanup. Electron acceptance checks conversation grouping, safe Markdown previews, search/timeline focus, manual folding, resizable panes, expanded JSON nodes, legacy text fallback, live metrics, exact exemplar navigation, restart persistence, and stale-response isolation on library reset.

Isolated Electron acceptance uses a temporary library and a local mock model:

```bash
LOOM_E2E_TRACE=1 pnpm --filter @loom/app build
cd packages/app
LOOM_E2E_TRACE=1 pnpm exec playwright test trace.spec.ts
```

On Windows, set the variable with the shell's environment syntax. Normal production builds omit the trace window.
