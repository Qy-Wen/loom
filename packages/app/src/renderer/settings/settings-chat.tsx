import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatLoginPrompt, ChatProviderCatalogEntry, ChatSettingsView } from "../../shared/ipc.ts";
import type { ChatModelsConfig, ChatProviderConfig, ChatThinkingLevel } from "@loom/agent/chat-models";
import type { ChatModelView } from "../../shared/chat-models.ts";
import { useLocale } from "../locale.tsx";

type LoginPromptEvent = ChatLoginPrompt & { providerId: string; authType: "api_key" | "oauth" };

interface LoginUiState {
	prompt: LoginPromptEvent;
}

/** Chat providers save immediately; they are not part of the Models save batch. */
export function SettingsChat(): React.JSX.Element {
	const { t } = useLocale();
	const [view, setView] = useState<ChatSettingsView | null>(null);
	const [catalog, setCatalog] = useState<ChatProviderCatalogEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [login, setLogin] = useState<LoginUiState | null>(null);
	const [loginInput, setLoginInput] = useState("");
	const [loginBusy, setLoginBusy] = useState(false);
	const loginWindow = useRef<Window | null>(null);

	async function reload(): Promise<void> {
		try {
			const [next, entries] = await Promise.all([
				window.loom.getChatSettings(),
				window.loom.chatProviderCatalog(),
			]);
			setView(next);
			setCatalog(entries);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	useEffect(() => {
		void reload();
		const unsubscribe = window.loom.onChatSettingsChanged(() => { void reload(); });
		return unsubscribe;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const unsubscribe = window.loom.onChatLoginPrompt((prompt) => {
			setLogin({ prompt });
			if (prompt.type === "text" || prompt.type === "secret" || prompt.type === "manual_code") setLoginInput("");
			if (prompt.type === "auth_url") {
				loginWindow.current = window.open(prompt.type === "auth_url" ? prompt.url : "", "_blank", "noopener,noreferrer");
			}
		});
		return unsubscribe;
	}, []);

	async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
		if (busy) return undefined;
		setBusy(true);
		setError(null);
		try {
			return await operation();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return undefined;
		} finally {
			setBusy(false);
		}
	}

	async function save(next: ChatModelsConfig): Promise<void> {
		const saved = await run(() => window.loom.saveChatSettings(next));
		if (saved) setView(saved);
	}

	async function startLogin(providerId: string, type: "api_key" | "oauth"): Promise<void> {
		setLoginBusy(true);
		setError(null);
		setLogin(null);
		try {
			await window.loom.chatLogin(providerId, type);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoginBusy(false);
			setLogin(null);
			loginWindow.current?.close();
			loginWindow.current = null;
			void reload();
		}
	}

	async function answerLogin(value: string | undefined): Promise<void> {
		if (!login) return;
		if (value === undefined) {
			await window.loom.chatCancelLogin();
			return;
		}
		try {
			await window.loom.chatLoginResponse(value);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	function patchProvider(providerId: string, patch: Partial<ChatProviderConfig>): void {
		if (!view) return;
		const providers = view.config.providers.map((provider) => provider.id === providerId ? { ...provider, ...patch } as ChatProviderConfig : provider);
		void save({ ...view.config, providers });
	}

	async function addBuiltin(entry: ChatProviderCatalogEntry): Promise<void> {
		if (!view) return;
		const providers = [...view.config.providers, { kind: "builtin", id: entry.id, enabled: true } as ChatProviderConfig];
		await save({ ...view.config, providers });
	}

	async function addCustom(baseUrl: string): Promise<void> {
		if (!view) return;
		const id = `custom-${Date.now().toString(36)}`;
		const providers = [...view.config.providers, {
			kind: "custom", id, enabled: true, baseUrl,
			api: "openai-completions",
			models: [{ id: "custom-model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192 }],
		} as ChatProviderConfig];
		await save({ ...view.config, providers });
	}

	async function removeProvider(providerId: string): Promise<void> {
		if (!view) return;
		const defaultNext = view.config.default?.provider === providerId ? undefined : view.config.default;
		const providers = view.config.providers.filter((provider) => provider.id !== providerId);
		await save({ ...view.config, providers, ...(defaultNext === undefined && view.config.default ? {} : { default: defaultNext }) });
	}

	const authByProvider = useMemo(() => new Map((view?.auth ?? []).map((row) => [row.providerId, row])), [view?.auth]);
	const modelsByProvider = useMemo(() => {
		const map = new Map<string, ChatModelView[]>();
		for (const model of view?.models ?? []) {
			const list = map.get(model.provider) ?? [];
			list.push(model);
			map.set(model.provider, list);
		}
		return map;
	}, [view?.models]);

	if (!view || !catalog) return <div className="empty">{t.common.loading}</div>;

	const availableBuiltin = catalog.filter((entry) => !view.config.providers.some((provider) => provider.id === entry.id));

	return (
		<div className="settings-form settings-form-docked">
			<div className="settings-form-scroll">
				<p>{t.settings.chat.lead}</p>
				{error && <div className="session-error">{error}</div>}

				{view.config.providers.map((provider) => {
					const auth = authByProvider.get(provider.id);
					const catalogEntry = catalog.find((entry) => entry.id === provider.id);
					const models = modelsByProvider.get(provider.id) ?? [];
					const isDefault = view.config.default?.provider === provider.id;
					return (
						<fieldset key={provider.id} className="settings-slot">
							<div className="settings-slot-head">
								<span className="settings-slot-title">{provider.name ?? catalogEntry?.name ?? provider.id}</span>
								<span className="settings-status-ok">{auth?.configured ? t.settings.chat.signedIn : t.settings.chat.notSignedIn}</span>
							</div>
							<div className="settings-chat-row">
								{catalogEntry?.apiKeyAuth && (
									<button type="button" disabled={loginBusy} onClick={() => void startLogin(provider.id, "api_key")}>
										{t.settings.chat.signInApiKey}
									</button>
								)}
								{catalogEntry?.oauthAuth && (
									<button type="button" disabled={loginBusy} onClick={() => void startLogin(provider.id, "oauth")}>
										{t.settings.chat.signInOauth}
									</button>
								)}
								<button type="button" disabled={busy} onClick={() => void removeProvider(provider.id)}>
									{t.settings.chat.removeProvider}
								</button>
							</div>
							{models.length > 0 && (
								<label>
									{isDefault ? t.settings.chat.defaultModel : ""}
									<select
										value={isDefault ? `${provider.id}:${view.config.default!.modelId}` : ""}
										onChange={(event) => {
											const [nextProvider, nextModel] = event.target.value.split(":");
											if (nextProvider && nextModel) void save({ ...view.config, default: { provider: nextProvider, modelId: nextModel, thinkingLevel: view.config.default?.thinkingLevel ?? "off" } });
										}}
									>
										{!isDefault && <option value="">{t.settings.chat.defaultModel}</option>}
										{models.map((model) => (
											<option key={model.id} value={`${provider.id}:${model.id}`}>
												{model.name} ({model.id}){model.available ? "" : " —"}
											</option>
										))}
									</select>
								</label>
							)}
							{isDefault && models.length > 0 && (
								<label>
									{t.settings.chat.thinking}
									<select
										value={view.config.default!.thinkingLevel}
										onChange={(event) => void save({ ...view.config, default: { ...view.config.default!, thinkingLevel: event.target.value as ChatThinkingLevel } })}
									>
										{(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => (
											<option key={level} value={level}>{level}</option>
										))}
									</select>
								</label>
							)}
							{models.length === 0 && <p>{t.settings.chat.noModels}</p>}
						</fieldset>
					);
				})}

				<div className="settings-chat-row">
					<select
						value=""
						onChange={(event) => {
							const entry = catalog.find((row) => row.id === event.target.value);
							if (entry) void addBuiltin(entry);
						}}
						aria-label={t.settings.chat.addProvider}
					>
						<option value="">{t.settings.chat.addProvider}</option>
						{availableBuiltin.map((entry) => (
							<option key={entry.id} value={entry.id}>{entry.name}</option>
						))}
					</select>
					<button
						type="button"
						disabled={busy}
						onClick={() => void addCustom("https://api.example.com/v1")}
					>
						{t.settings.chat.custom}
					</button>
					<button type="button" disabled={busy} onClick={() => void run(async () => setView(await window.loom.chatRefresh()))}>
						{busy ? t.settings.chat.refreshing : t.settings.chat.refresh}
					</button>
				</div>
				{view.config.default === undefined && <p className="settings-path">{t.settings.chat.notConfigured}</p>}
			</div>

			{login && (
				<div className="settings-login-overlay" role="dialog" aria-label={t.settings.chat.loginTitle}>
					<div className="settings-login-card">
						<h3>{t.settings.chat.loginTitle}</h3>
						<p>{"message" in login.prompt ? login.prompt.message : t.settings.chat.loginProgress}</p>
						{login.prompt.type === "auth_url" && (
							<button type="button" onClick={() => { loginWindow.current = window.open(login.prompt.type === "auth_url" ? login.prompt.url : "", "_blank", "noopener,noreferrer"); }}>
								{t.settings.chat.openUrl}
							</button>
						)}
						{(login.prompt.type === "text" || login.prompt.type === "secret" || login.prompt.type === "manual_code") && (
							<input
								type={login.prompt.type === "secret" ? "password" : "text"}
								value={loginInput}
								placeholder={login.prompt.placeholder ?? (login.prompt.type === "manual_code" ? t.settings.chat.enterCode : "")}
								autoComplete="off"
								autoFocus
								onChange={(event) => setLoginInput(event.target.value)}
								onKeyDown={(event) => { if (event.key === "Enter") void answerLogin(loginInput); }}
							/>
						)}
						{login.prompt.type === "select" && (
							<select autoFocus defaultValue="" onChange={(event) => { if (event.target.value) void answerLogin(event.target.value); }}>
								<option value="" disabled>{t.settings.chat.selectMethod}</option>
								{login.prompt.options.map((option) => (
									<option key={option.id} value={option.id}>{option.label}</option>
								))}
							</select>
						)}
						{login.prompt.type === "device_code" && (
							<p className="settings-path">{login.prompt.userCode} — {login.prompt.verificationUri}</p>
						)}
						<div className="settings-chat-row">
							{login.prompt.type !== "select" && login.prompt.type !== "device_code" && login.prompt.type !== "info" && login.prompt.type !== "progress" && (
								<button className="primary-button" type="button" disabled={loginBusy} onClick={() => void answerLogin(loginInput)}>{t.settings.chat.loginAnswer}</button>
							)}
							<button type="button" onClick={() => void answerLogin(undefined)}>{t.settings.chat.loginCancel}</button>
						</div>
					</div>
				</div>
			)}
			</div>
	);
}
