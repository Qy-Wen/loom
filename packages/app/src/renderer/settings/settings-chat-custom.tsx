import { useRef, useState } from "react";
import { CHAT_APIS, validateChatBaseUrl, type ChatApi, type ChatCustomProviderConfig } from "@loom/agent/chat-models";
import { useLocale } from "../locale.tsx";
import { buildCustomProvider, customModelDraft, customProviderDraft, CustomDraftError, type CustomModelDraft } from "./chat-custom-draft.ts";
import { chatEndpointUrl, detectChatEndpoint } from "../../shared/chat-endpoint.ts";

const API_LABELS: Record<ChatApi, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Gemini",
};

/** Local non-secret draft. Only Save provider publishes it; credentials use the separate login flow. */
export function SettingsChatCustom({ id, provider, busy, onSave, onCancel }: {
	id: string;
	provider?: ChatCustomProviderConfig;
	busy: boolean;
	onSave: (provider: ChatCustomProviderConfig) => Promise<boolean>;
	onCancel: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const [draft, setDraft] = useState(() => customProviderDraft(provider));
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const nextKey = useRef(draft.models.length);
	const disabled = busy || saving;
	const detected = draft.manualApi ? undefined : detectChatEndpoint(draft.requestUrl);
	let canUseBaseUrl = false;
	try { validateChatBaseUrl(draft.requestUrl.trim()); canUseBaseUrl = true; } catch { /* Invalid/secret URLs are never a fallback. */ }

	function patchUrl(requestUrl: string): void {
		const endpoint = draft.manualApi ? undefined : detectChatEndpoint(requestUrl);
		setDraft((current) => ({ ...current, requestUrl, models: current.models.map((model, index) =>
			index === 0 && !model.id && endpoint?.modelId ? { ...model, id: endpoint.modelId } : model,
		) }));
	}

	function patchModel(key: number, patch: Partial<CustomModelDraft>): void {
		setDraft((current) => ({ ...current, models: current.models.map((model) => model.key === key ? { ...model, ...patch } : model) }));
	}

	async function submit(): Promise<void> {
		if (disabled) return;
		setError(null);
		setSaving(true);
		try {
			const next = buildCustomProvider(id, draft, provider);
			if (!await onSave(next)) setError(t.settings.chat.customSaveFailed);
		} catch (cause) {
			const messages = {
				baseUrl: t.settings.chat.invalidRequestUrl, protocol: t.settings.chat.unknownProtocol,
				query: t.settings.chat.unsupportedQuery, modelIds: t.settings.chat.invalidModelIds,
				tokenLimits: t.settings.chat.invalidTokenLimits, noModels: t.settings.chat.requireModels,
			};
			setError(cause instanceof CustomDraftError ? messages[cause.code] : t.settings.chat.customSaveFailed);
		} finally { setSaving(false); }
	}

	return (
		<div className="settings-chat-custom" role="group" aria-label={provider ? t.settings.chat.editCustom : t.settings.chat.addCustom} onKeyDown={(event) => {
			// This editor is inside the dialog's outer form, not a nested HTML form.
			if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
				event.preventDefault(); void submit();
			}
		}}>
			<h3>{provider ? t.settings.chat.editCustom : t.settings.chat.addCustom}</h3>
			<p>{t.settings.chat.customHint}</p>
			<label>
				{t.settings.chat.providerName}
				<input value={draft.name} disabled={disabled} autoFocus onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
			</label>
			<label>
				{draft.manualApi ? t.settings.baseUrl : t.settings.requestUrl}
				<input value={draft.requestUrl} disabled={disabled} placeholder={draft.manualApi ? "https://api.example.com/v1" : "https://api.example.com/v1/chat/completions"} autoComplete="off" onChange={(event) => patchUrl(event.target.value)} />
			</label>
			{detected && <p className="settings-path" role="status">{t.settings.chat.detectedProtocol(API_LABELS[detected.api])}</p>}
			{!draft.manualApi && !detected && canUseBaseUrl && (
				<div className="settings-chat-provider-actions">
					<button type="button" disabled={disabled} onClick={() => setDraft({ ...draft, manualApi: "openai-completions" })}>{t.settings.chat.useBaseUrl}</button>
				</div>
			)}
			{draft.manualApi && <>
				<label>
					{t.settings.chat.protocol}
					<select value={draft.manualApi} disabled={disabled} onChange={(event) => setDraft({ ...draft, manualApi: event.target.value as ChatApi })}>
						{CHAT_APIS.map((api) => <option key={api} value={api}>{API_LABELS[api]}</option>)}
					</select>
				</label>
				<div className="settings-chat-provider-actions">
					<button type="button" disabled={disabled} onClick={() => setDraft({ ...draft, requestUrl: chatEndpointUrl(draft.requestUrl, draft.manualApi!, draft.models[0]?.id), manualApi: undefined })}>{t.settings.chat.useRequestUrl}</button>
				</div>
			</>}
			{draft.models.map((model, index) => (
				<fieldset key={model.key} className="settings-chat-custom-model" aria-label={t.settings.chat.modelNumber(index + 1)}>
					<legend>{t.settings.chat.modelNumber(index + 1)}</legend>
					<label>
						{t.settings.chat.customModelId}
						<input value={model.id} disabled={disabled} autoComplete="off" onChange={(event) => patchModel(model.key, { id: event.target.value })} />
					</label>
					<label>
						{t.settings.chat.modelName}
						<input value={model.name} disabled={disabled} onChange={(event) => patchModel(model.key, { name: event.target.value })} />
					</label>
					<details className="settings-advanced">
						<summary>{t.settings.advanced}</summary>
						<div className="settings-advanced-body">
							<p>{t.settings.chat.capabilityHint}</p>
							<div className="settings-chat-custom-limits">
								<label>
									{t.settings.contextWindow}
									<input type="number" min="1" step="1" value={model.contextWindow} disabled={disabled} onChange={(event) => patchModel(model.key, { contextWindow: event.target.value })} />
								</label>
								<label>
									{t.settings.chat.maxOutputTokens}
									<input type="number" min="1" step="1" value={model.maxTokens} disabled={disabled} onChange={(event) => patchModel(model.key, { maxTokens: event.target.value })} />
								</label>
							</div>
							<label className="settings-chat-custom-check">
								<input type="checkbox" checked={model.image} disabled={disabled} onChange={(event) => patchModel(model.key, { image: event.target.checked })} />
								{t.settings.chat.supportsImages}
							</label>
							<label className="settings-chat-custom-check">
								<input type="checkbox" checked={model.reasoning} disabled={disabled} onChange={(event) => patchModel(model.key, { reasoning: event.target.checked })} />
								{t.settings.chat.supportsReasoning}
							</label>
						</div>
					</details>
					<div className="settings-chat-provider-actions">
						<button type="button" disabled={disabled} onClick={() => setDraft({ ...draft, models: draft.models.filter((row) => row.key !== model.key) })}>{t.settings.chat.removeModel}</button>
					</div>
				</fieldset>
			))}
			{error && <div className="session-error" role="alert">{error}</div>}
			<div className="settings-actions settings-chat-custom-actions">
				<button type="button" disabled={disabled} onClick={() => setDraft({ ...draft, models: [...draft.models, customModelDraft(nextKey.current++)] })}>{t.settings.chat.addModel}</button>
				<button type="button" className="settings-chat-custom-cancel" disabled={disabled} onClick={onCancel}>{t.common.cancel}</button>
				<button type="button" className="primary-button" disabled={disabled} onClick={() => void submit()}>{t.settings.chat.saveProvider}</button>
			</div>
		</div>
	);
}
