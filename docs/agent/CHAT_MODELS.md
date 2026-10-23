**English** | [简体中文](./CHAT_MODELS.zh-CN.md)

# Full Chat Model Integration with pi-ai

> Status: the native runtime owns production Chat; legacy endpoint compatibility is removed. Windows automated tests, OS encryption/mock OAuth callbacks, and live native DeepSeek chat are verified. Real OAuth, other native services, and installer acceptance remain.
> Current behavior: [AGENT](./AGENT.md), [SETTINGS](../SETTINGS.md). Baseline: installed `@earendil-works/pi-ai@1.4.0`; reference sources: `agent/pi/packages/ai` and `agent/pi/packages/coding-agent/src/core`.

## 1. Scope and decisions

- Chat uses pi-ai Providers, catalogs, native protocols, authentication, and capability metadata, including **API keys and OAuth login**.
- **App defaults fill new independent conversations and conversations without a model.** Each conversation persists its model and thinking level, retains them on reopen, and forks retain the selection at the branch point. Specialists inherit their parent by default.
- Reuse built-in Provider factories. Custom connections cover proxies, local services, and uncataloged models. Do not disguise every connection as `loom-chat`.
- Loom owns configuration, persistent credentials, UI, and selection policy. pi-ai owns protocol conversion, auth resolution, OAuth refresh, streaming events, and usage. Durable retains scheduling, retries, compaction, cancellation, and recovery.
- Do not import the whole pi-coding-agent, edit vendor sources, or implement OAuth/LLM streaming protocols ourselves.
- Out of scope: changing Embedding/Rerank/VLM/Audio integration or credential storage, model loading/deployment, automatic routing/failover, multiple accounts, and independent specialist model selection.

## 2. Current gaps

| Removed legacy behavior | Replacement |
|---|---|
| Chat shared URL / Key / Model forms with four other slots | Separate Chat Provider management in Settings → Models; other slots unchanged |
| One hardcoded `loom-chat` Chat Completions provider | Native built-in Providers plus explicit custom protocols |
| Defaults: 128k context, 8192 output, vision on, reasoning off, zero prices | Built-in catalog metadata; explicitly declared custom capabilities, no guessing |
| Plaintext API key in `model-settings.json`, returned to settings UI | Separate encrypted Chat credentials (`chat-credentials.json`, safeStorage); ordinary queries return status only |
| Chat edits configured every conversation | App defaults affect new independent conversations only |
| JSON from `/models` counted as success | Provider auth status through the native runtime |

## 3. Architecture and boundaries

```text
Renderer: Provider settings / login interaction / conversation model picker
    │ IPC: config, non-secret catalog/status, login events
Main: ChatModelService + config/credential/catalog storage
    │ pure model assembly and contracts from @loom/agent
pi-ai Models: built-in + custom Providers
    │ injected into existing ChatService / LibraryRuntime
pi-durable Harness: conversation selection, generation, compaction, recovery
```

Names describe proposed responsibilities, not a requirement to split files mechanically:

| Location | Responsibility |
|---|---|
| `packages/agent/src` | Replace endpoint-only adapter: Provider assembly, custom model validation, model metadata/thinking levels; no Electron, app storage, or UI dependencies |
| `packages/app/src/main` | One long-lived app-level Chat runtime; configuration, encrypted credentials, catalog cache, login lifecycle, IPC |
| `packages/app/src/main/chat/chat-service.ts` | Receive `Models` and new-conversation defaults; configure selected conversations, not temporary single-model collections or all history |
| `packages/app/src/shared` | JSON config/catalog/auth-status/login DTOs; no Provider/durable handles or credential objects |
| `packages/app/src/renderer` | Settings and conversation UI; requests and auth execute in Main |

Keep AG-UI, trace, and tools intact. Per-Harness trace wrappers may observe the shared runtime without duplicating credentials or Provider collections.

## 4. Configuration, catalogs, and auth

### 4.1 Separate three data categories

Proposed storage in Electron `userData`, never the library:

| Data | Proposed file/store | Contents |
|---|---|---|
| Non-secret configuration | Versioned `chat-models.json` | Provider enablement, endpoint overrides, custom models, capability/compat overrides, generation defaults, app default `{ provider, modelId, thinkingLevel }` |
| Chat credentials | Separate encrypted `CredentialStore` | One API-key or OAuth credential per Provider ID; secret headers also stored through secret references |
| Dynamic catalog | `chat-model-catalog.json`, implementing `ModelsStore` | Recoverable catalog snapshots and sources, without credentials |
| Conversation selection | Durable `pi.agent` in the library | Model reference and thinking level, never keys |

- Preserve native Provider IDs. Assign stable custom IDs; renaming does not change identity. Equal model IDs on different Providers remain distinct.
- One credential per Provider matches pi-ai. Switching API key/OAuth replaces the auth method rather than managing multiple accounts.
- Default selection, conversation selection, and Provider enablement are independent. Disable/delete/logout does not replace saved conversation selections; unselected conversations can use another enabled, available model.
- Persist an explicit model and thinking level when creating a conversation; do not let later app-default changes alter it implicitly.

### 4.2 Built-in and custom Providers

- Preserve factory auth, filtering, dynamic catalog policy, protocol dispatch, and complete metadata. Compose thin endpoint/header/model overrides instead of copying factory implementations.
- Use built-in catalogs for browsing, retain lazy SDK loading, and register only enabled Providers in the execution collection. Chat pickers exclude image/classifier operations and list chat/tool-capable models.
- Custom protocols are explicit. Cover at least `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`; use native Providers for specialized cloud protocols first.
- Custom model IDs may be entered manually with text/image input, reasoning, context window, and output ceiling. Advanced configuration supports headers, compat, thinking-level maps, and price overrides; the ordinary form need not expose every field.
- Unknown models do not inherit vision/reasoning assumptions. A custom `/models` list can suggest IDs, not fabricate missing capabilities. Unknown pricing means “unknown,” not “free.” If pi-ai requires zero placeholders, retain separate price-known/source metadata rather than treating placeholder costs as actual charges.
- Preserve untouched built-in fields when overriding models; distinguish proxy price overrides from official catalog prices. Equal names do not imply equal protocols or capabilities.

### 4.3 Catalog reads and refresh

- Bundled static catalogs allow offline browsing. Only refresh-capable Providers use `Models.refresh()` for dynamic listings; restore cached listings with `allowNetwork: false`.
- **Not every built-in Provider in pi-ai 1.4.0 refreshes its catalog over the network.** Pi CLI's online catalog overlays are not a generic pi-ai API. Do not build another catalog service in this scope.
- Refresh availability after login, credential replacement, and explicit catalog refresh. Keep the previous catalog on network failure and show errors/sources without clearing selections. Queries/refresh support cancellation and timeouts.
- Catalog presence, configured auth, and successful inference are separate states. Keep missing model references in conversation DTOs, marked unavailable.

### 4.4 Credentials and OAuth

- Encrypt persisted Chat credentials with Electron `safeStorage`; report unavailable encryption or decryption failure, never fall back to plaintext. Validate permissions, atomic writes, locks, and replacement on macOS and Windows.
- Serialize `CredentialStore.modify()` / `delete()` so refresh/login/logout cannot overwrite each other. Coordinate cross-process writes rather than relying solely on an in-memory lock.
- Let native Provider auth resolve environment/ambient sources and show their labels. Failed stored credentials do not silently fall back to env. Logout removes stored auth only; environment auth may remain. Disabling a Provider prevents new calls.
- Renderer never receives stored keys/access/refresh tokens. It submits new keys or reads redacted status. Auth errors, IPC, trace, diagnostics, and catalog cache must not expose secrets.
- Use `Models.login()` / `logout()` and bridge `AuthInteraction` text/secret/select/manual_code prompts plus info/auth_url/device_code/progress events. Support cancellation, window close, app exit, and manual callbacks.
- Login/logout are explicit immediate actions, separate from settings drafts. Canceling settings does not undo completed login. Provider registration does not prove every OAuth flow works; verify the installed version and Electron packaging per flow.
- Supply Loom's device ID/app name through pi-ai login options; do not replace upstream OAuth client protocols. Validate login URLs before browser opening or callback handling.

## 5. Conversation and request semantics

| Action | Behavior |
|---|---|
| Change settings default model/thinking | Only later independent conversations change |
| Select model/thinking in a conversation | Persist through native configure; effective for the next request |
| Reopen/recover | Restore saved selection, not current app defaults |
| Fork/edit an old question | Preserve branch-point model/thinking; source unchanged |
| Create/replay specialist | Inherit parent by default; existing children keep persisted selection |
| Missing Provider/failed auth | Explain and require configuration/manual selection; no failover |

- Reject conversation model changes while foreground work, relevant owned tasks, or compaction is active. Show busy status; do not build another scheduler queue. Provider edits/disable/delete and catalog publication must also protect requests using them.
- Keep active request objects unchanged and gate Provider mutations while relevant work is busy. Use native durable recovery: checkpoints retain model/thinking; resent requests resolve current available Provider metadata/defaults. Do not promise cross-restart snapshots or persist auth in checkpoints. Ordinary OAuth refresh is not a model switch.
- Validate/persist supported thinking with `getSupportedThinkingLevels()` / `clampThinkingLevel()`, not hand-maintained vendor maps. Reuse durable thinking and AG-UI reasoning events.
- Distinguish model `maxTokens` capability from the user's generation budget. Generation defaults are connection/model-scoped; per-conversation controls in this scope save model and thinking, not another sampling editor.
- Current `ConversationStreamOptions` lacks `maxTokens` / `temperature`. Inject defaults through public Provider request APIs, with explicit request values winning and compaction budgets preserved. Recovery reapplies current defaults under the approved A semantics; no private APIs or vendor changes.
- Reject new image attachments for text-only models with an explanation. Do not rewrite existing image history/tool results; retain pi-ai/durable compatibility handling and show limitations. Recalculate context occupancy for the selected window without reusing old-model usage.
- Retain real usage/cost. Label catalog prices as estimates, subscription access is not a metered bill, and unknown prices do not show zero cost. A complete Stats redesign is unnecessary, but model prices must no longer be uniformly zeroed.

## 6. UI, connection testing, and settings tools

- A separate Chat area within Models settings: Provider list, enablement/auth status, API-key/OAuth actions, model search/refresh, default model/thinking, custom connection advanced settings. Keep the other four slot forms.
- Conversation composer offers model/thinking selection and shows the actual selection, capabilities, and unavailable reasons. Tab changes must not mix state.
- Explicit Chat “Test connection,” not enablement or `/models` success as an inference check. Send a small `completeSimple()` request through the same runtime; inspect terminal result, timeout, and cancellation. Warn of possible charges.
- This checks basic selected-model inference, not every tool/image/OAuth capability; separate acceptance tests cover those. Draft testing does not replace saved Providers or persist unsaved credentials.
- Update Chat schemas in `get_settings` / `update_settings`: defaults affect new conversations only, queries return redacted Provider/model status, existing write approval remains. No interactive OAuth or secret reads through chat tools.
- Login is immediate; ordinary configuration takes effect after Save. Validate complete multi-file changes and commit recoverably so failures cannot leave defaults pointing to an unsaved Provider.

## 7. Legacy removal (completed)

- The product is unreleased, so no legacy compatibility is kept: `LoomChatEndpoint`, `buildChatModels`, `pi-adapter.ts`, the legacy Host `setChat`/bulk-configure path, and the staged `chat-migration.ts` cutover are deleted.
- `model-settings.json` keeps only the four non-Chat slots. Old Chat entries in existing files are ignored; interrupted requests that referenced `loom-chat` are not expected to resume.
- History/transcripts are never rewritten. Old conversations that referenced removed models keep their records; models are re-resolved when a matching Provider exists.
- Without saved configuration, `DEEPSEEK_API_KEY` enables the native DeepSeek Provider without selecting a model. Environment secrets are never persisted; authentication uses pi-ai's native environment support.

## 8. Verification and implementation status

### Verified

- pi-ai 1.4.0 has 42 built-in Providers, 41 with Chat models; **only Radius has native dynamic catalog refresh**. Nine factories advertise OAuth: Anthropic, GitHub Copilot, Kimi Coding, Meta, OpenAI, OpenAI Codex, OpenRouter, Radius, xAI.
- Thin model overlays preserve native auth, OAuth model filtering, dynamic publication/offline cache, mixed protocol dispatch, and untouched capability/pricing metadata. OAuth-derived endpoints such as Copilot's take priority over static model endpoints; proxy settings must not silently override them.
- Offline payload construction passes for OpenAI Responses, Anthropic Messages, Google Generative AI, DeepSeek Chat Completions, and Copilot's three protocols. These are not hosted inference acceptance tests.
- `Provider.headers` is metadata in the installed version; modifying it alone does not apply request headers. Use model headers/public request options and retain pi-ai merge precedence.
- `streamSimple()` accepts injected defaults and explicit values win. Real durable compaction keeps its own 800-token cap rather than an injected 4096-token generation budget.
- macOS arm64 / Electron 38.2.2: `safeStorage` encryption and decryption in another Electron process pass. A build retaining the npm package lazily loads nine OAuth flows and four native SDKs. Mock OpenAI loopback login verifies wrong-state rejection, valid callback, Loom device/app identification, cancellation, and listener closure. No browser opening or real service calls.

### Packaging

Flattening pi-ai breaks OAuth's opaque relative imports. Isolated builds reproduce the old layout and verify the retained npm package. The app declares pi-ai 1.4.0 directly in its dependencies, enabling the existing externalization policy; the app build passes. Final installer/package-content validation remains P2/P5; OAuth imports must not resolve under app `out/main`. Windows on-device and real login remain untested.

### Approved request semantics (A)

Retain native durable recovery, without vendor changes. Checkpoints save model reference, thinking, and limited stream options, not full metadata/defaults. The reopen test retains the reference and memo budget 64 but resends with current budget 256/window 32000. No cross-restart metadata/parameter snapshot is promised.

The public busy probe shows running generations via `Harness.inspect()` and confirms an active request keeps its captured model/options. **Native `configure()` does not reject model changes while busy.** Loom must enforce conversation/owned-task/compaction and Provider publication guards in P2/P4, before calling native mutation APIs.

### P1 storage

- `@loom/agent/chat-models` defines schema v1, explicit custom capabilities/protocols, generation defaults, optional price overrides, and header-secret references. Shared catalog/auth DTOs contain no credentials. Unknown custom prices remain absent, not zeroed.
- Main stores configuration, OS-encrypted credentials/header values, and native catalogs separately. Credential mutations hold a heartbeat-backed cross-process lock through OAuth refresh. JSON replacements use same-directory temporary files, file sync, restrictive permissions, and Windows retry handling; malformed/decryption-failed data is not silently reset.
- Catalog tests cover all 42 native factories, including mixed operation types, blank ambient cloud endpoints, native negative unknown-price markers, and Radius's literal routing auth-source references. Headers are omitted from cache and must be reapplied by the runtime.
- **Environment bootstrap:** first run without saved configuration enables the native DeepSeek Provider when `DEEPSEEK_API_KEY` is present; users choose the conversation model. Environment secrets are never persisted.

### P2 runtime foundation

- `packages/agent/src/models/chat-provider.ts` assembles native factories and four explicit custom protocols. Thin overlays preserve auth/filter/refresh/dispatch and merge only declared metadata/defaults. API-keyless custom connections require explicit permission; custom IDs cannot collide with native IDs.
- `packages/app/src/main/models/chat-model-service.ts` owns one long-lived execution collection, registers enabled Providers, restores/refreshes native catalogs, and emits credential-free views. Unknown prices omit rates; default-only saves retain Provider objects and dynamic state. Headers are resolved only in Main memory, not public DTOs or cache.
- The injected `ChatService` path persists defaults only for new independent conversations; tests retain old selections on fork/reopen. Provider edits/publication hold a public Session commit while checking live tasks/inbox, including compaction; direct request activity is also guarded. Per-conversation changes use the same busy guards (`setSessionModel`).
- Known request/auth secrets feed trace redaction and are removed from provider error messages before durable bookkeeping. Real legacy interrupted-request recovery and the 800-token compaction cap pass through the new service.
- **Production startup is switched:** `app.whenReady()` builds `ChatModelService` from `createChatStorage(userData)`, initializes it (env bootstrap on first run), and injects the long-lived `Models` plus defaults into `ChatService`. ChatService never builds Providers; secrets feed trace redaction through `onSecrets`.
- Chat IPC: `getChatSettings`/`saveChatSettings` (credential-free views), `chatProviderCatalog`, `chatLogin`/`chatLoginPrompt`/`chatLoginResponse`/`chatCancelLogin` (API-key + OAuth interaction bridged to the renderer), `chatRefresh`, `chatSettingsChanged`. Settings tools no longer expose a Chat slot.
- Renderer: `SettingsChat` manages providers, API-key/OAuth login, model enablement, and refresh. The composer selects each conversation's model, with thinking levels in a model submenu.
- Eval/smoke scripts and vendor tests build custom providers through `createChatCustomProvider` with in-memory credentials; `LoomChatEndpoint` consumers are gone.

### Reproduction

```bash
pnpm typecheck
pnpm --filter @loom/agent test
pnpm --filter @loom/app test
pnpm --filter @loom/app build
pnpm --filter @loom/app check:chat-platform    # temporary userData, fake credentials/mock callbacks; requires Electron/OS encryption
```

P0 prototypes remain test-only; production startup uses the native assembly/service and ChatService injection path.

## 9. Remaining acceptance checklist

Completed acceptance results are in the [archive](../archive/ARCHIVE.md#windows-chat-acceptance).

### P4: Conversation selection

- [ ] Image-capability notices after model changes; unavailable providers never switch automatically.

### P5: Regression and delivery

- [ ] Complete interactive login/logout race acceptance.
- [ ] Complete the four-protocol tools/usage/cancellation and cross-protocol/provider history conversion matrix.
- [ ] Native OpenAI/Anthropic/Google services and real OAuth login/refresh/logout.
- [ ] Mac revalidation and macOS/Windows packaged-runtime acceptance.

Done means users configure Chat from built-in catalogs or custom connections with API keys/OAuth and create/recover independently selected conversations. Tools, thinking, usage, compaction, cancellation, and recovery remain on native pi-ai/durable paths. Secrets never enter libraries or ordinary queries. Unchecked items are not complete.
