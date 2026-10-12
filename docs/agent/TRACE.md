**English** | [简体中文](./TRACE.zh-CN.md)

# Local Agent Traces

Development mode records traces in `<library>/.agents/traces/traces.sqlite`. The Traces window shows the current library's latest 40 runs and can load older pages. Switching libraries resets the view. Records survive renderer reloads and app restarts; there is no automatic deletion or upload. Production builds do not enable recording or include the trace window.

## Boundaries

- `DurableTrace` is a Loom-owned extension and commit observer. It follows submission/task/conversation ownership, including parallel specialists and nested calls; it never schedules, retries, or changes model context.
- `traceModels()` observes public `Models` requests, compaction requests, and deferred polls. It forwards the original options, events, and results without consuming ahead of durable. A diagnostic failure must not fail Chat.
- SQLite WAL stores atomic record revisions independently of `.loom/loom.sqlite`. Request starts are saved before provider dispatch; live updates coalesce at 100 ms and settled boundaries flush. This is diagnostic storage, not a recovery checkpoint or a distributed transaction with durable; a crash can lose the latest diagnostic update.
- Task timing uses native `startedAt`/`endedAt`; tool `durationMs` measures execution separately from approval/task lifetime. First-content timing is Pi content observation, not HTTP TTFT. HTTP headers, status, and raw wire payloads are not captured.

## Contents and privacy

Each root run contains generation, model-request, tool, approval-wait, retry, and compaction spans. Background/manual compaction has its own record. Model spans include model/provider/API, stop reason, response identity when available, token/cache usage, and bounded input/output. Tool results include committed diagnostics. The window updates existing records by revision.

Known Chat keys and common credential fields/patterns are redacted before saving. Images, signatures, and headers are omitted. Each input/output field is limited to approximately 8 KiB of UTF-8 text. **This is best-effort redaction, not anonymization:** prompts, memory, source text, file paths, and tool output may still contain private information. The local database is not encrypted; protect the library and do not share its traces indiscriminately.

After a crash, unfinished spans become `interrupted`. Native recovery reconnects to the same persisted trace and adds a fresh model attempt, retaining the interrupted attempt. Unsafe tools retain their uncertain result rather than being rerun by tracing.

## Validation

Tests use temporary libraries and cover consecutive runs, live updates before completion, ownership, approvals/reopen, retry, deferred polls, compaction, Stop, diagnostic failure isolation, privacy, pagination, and SIGKILL during streaming/unsafe tools.

Isolated Electron window acceptance (never use an asset library):

```bash
LOOM_E2E_TRACE=1 pnpm --filter @loom/app build
cd packages/app
LOOM_E2E_TRACE=1 pnpm exec playwright test trace.spec.ts
```

On Windows, set `LOOM_E2E_TRACE=1` using your shell's environment syntax. The acceptance flag only enables the test window when `LOOM_E2E=1`; normal production builds still omit it. Windows on-device validation remains outstanding.
