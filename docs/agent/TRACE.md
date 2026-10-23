**English** | [简体中文](./TRACE.zh-CN.md)

# Local Agent Traces

Development mode records traces in `<library>/.agents/traces/telemetry.sqlite`. Records and metrics expire 30 days after their last update; cleanup runs on open and every minute. The viewer shows the latest 40 traces and supports pagination. Switching libraries resets it. Production builds do not record or include the trace window. No data is uploaded.

The old `traces.sqlite` is left untouched and is not read or migrated.

## Recording

- Pass `DurableTrace.telemetry` through `LibraryRuntime` to `HarnessOptions.telemetry`. Pi supplies submission/phase/request/poll instrumentation, events, metric updates, and persisted context propagation.
- `LiveTelemetry` implements the native adapter contract: span identities, timing, links, attributes, events, statuses, and metric aggregation. It persists unfinished spans for live display and crash diagnostics; native Chord SQLite stores only settled spans.
- `DurableTrace.models()` adds redacted input/output to the existing native request span. It creates no request spans and does not infer task identity from signals or checkpoints.
- Tool hooks add arguments and results. The commit content observer adds final bounded tool output, including blocked/interrupted diagnostics. `DurableTrace` derives submission summaries only from committed state and owns the viewer's status rules; the recorder does not interpret durable events. `ToolGate` records `loom.approval` around approval waits.
- Native input submissions are separate root traces. Specialist inputs link to their calling tool; the viewer shows those links. Nested tools use native parentage within a trace.
- SQLite WAL is independent of `.loom/loom.sqlite`. Starts are saved before request dispatch; content updates coalesce at 100 ms and native settlement flushes. A diagnostic write failure disables recording while Chat continues.

After a crash, unfinished spans become `interrupted`. Native carriers reconnect recovered work to the same trace; interrupted attempts remain visible. Tracing never schedules or replays tools.

## Contents and privacy

Native metadata includes model/provider/API, stop reason, response ID, usage/cost, first-chunk events, phase outcomes, and bounded errors. Counters and histograms aggregate into ten-second intervals.

Input/output uses the existing redaction policy: known Chat secrets and credential patterns are removed; images, signatures, and headers are omitted. Requests keep the latest 200 messages, each independently bounded. Long system/tool text shows a 600-character preview with an Expand button; deduplicated redacted full text is capped at 4 MiB. Ordinary payload fields are bounded to about 8 KiB.

This is best-effort redaction, not anonymization: prompts, memory, paths, and tool output can contain private information. The local database is not encrypted.

## Validation

Coverage includes the native adapter conformance suite, propagation/links, live and SIGKILL recovery, approvals, retry, deferred polls, compaction, diagnostic failure isolation, redaction, pagination, and 30-day cleanup.

Isolated Electron acceptance uses a temporary library and a local mock model:

```bash
LOOM_E2E_TRACE=1 pnpm --filter @loom/app build
cd packages/app
LOOM_E2E_TRACE=1 pnpm exec playwright test trace.spec.ts
```

On Windows, set the variable with the shell's environment syntax. Normal production builds omit the trace window.
