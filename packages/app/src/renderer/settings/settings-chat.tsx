import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatLoginPrompt, ChatProviderCatalogEntry, ChatSettingsView } from "../../shared/ipc.ts";
import type { ChatCustomProviderConfig } from "@loom/agent/chat-models";
import type { ChatModelView } from "../../shared/chat-models.ts";
import { useLocale } from "../locale.tsx";
import { SettingsStatus } from "./settings-switch.tsx";
import { SettingsChatCustom } from "./settings-chat-custom.tsx";
import { changedFields } from "../../shared/settings-changes.ts";
import type { ChatSettingsPatch, ChatProviderPatch } from "../../shared/chat-settings.ts";
import { SettingsSecretInput } from "./settings-secret-input.tsx";
import { useConfirmation } from "../components/confirm-dialog.tsx";

type LoginPromptEvent = ChatLoginPrompt & { providerId: string; authType: "api_key" | "oauth" };

interface LoginUiState {
	prompt: LoginPromptEvent;
}

/** Chat providers save immediately; they are not part of the Models save batch. */
export function SettingsChat(): React.JSX.Element {
	const { t } = useLocale();
	const { confirm } = useConfirmation();
	const [view, setView] = useState<ChatSettingsView | null>(null);
	const [catalog, setCatalog] = useState<ChatProviderCatalogEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [login, setLogin] = useState<LoginUiState | null>(null);
	const [loginInput, setLoginInput] = useState("");
	const [loginBusy, setLoginBusy] = useState(false);
	const [loginAnswerBusy, setLoginAnswerBusy] = useState(false);
	const [collapsedModels, setCollapsedModels] = useState<ReadonlySet<string>>(() => new Set());
	const [customEditor, setCustomEditor] = useState<{ id: string; provider?: ChatCustomProviderConfig } | null>(null);
	const loginWindow = useRef<Window | null>(null);
	const loginAttempt = useRef<{ cancelled: boolean } | null>(null);

	/** `keepError`: a refresh after a failed action must not wipe the error that action just reported. */
	async function reload(keepError = false): Promise<void> {
		try {
			const [next, entries] = await Promise.all([
				window.loom.getChatSettings(),
				window.loom.chatProviderCatalog(),
			]);
			setView(next);
			setCatalog(entries);
			if (!keepError) setError(null);
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
			if (loginAttempt.current?.cancelled) return;
			setLogin({ prompt: prompt.type === "secret" ? { ...prompt, initialValue: undefined } : prompt });
			setLoginAnswerBusy(false);
			if (prompt.type === "text" || prompt.type === "secret" || prompt.type === "manual_code") {
				setLoginInput(prompt.type === "secret" && prompt.authType === "api_key" ? prompt.initialValue ?? "" : "");
			}
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

	async function save(patch: ChatSettingsPatch): Promise<boolean> {
		const saved = await run(() => window.loom.patchChatSettings(patch));
		if (!saved) return false;
		setView(saved);
		return true;
	}

	/** Main announces the change, so the list refreshes through onChatSettingsChanged. */
	async function signOut(providerId: string, name: string): Promise<void> {
		if (!await confirm({
			title: t.settings.chat.signOutTitle(name),
			description: t.settings.chat.signOutConfirm(name),
			confirmLabel: t.settings.chat.signOut,
		})) return;
		await run(() => window.loom.chatLogout(providerId));
	}

	async function startLogin(providerId: string, type: "api_key" | "oauth"): Promise<void> {
		if (loginAttempt.current) return;
		const attempt = { cancelled: false };
		loginAttempt.current = attempt;
		setLoginBusy(true);
		setLoginAnswerBusy(false);
		setLoginInput("");
		setError(null);
		setLogin(null);
		let failed = false;
		try {
			await window.loom.chatLogin(providerId, type);
		} catch (cause) {
			if (!attempt.cancelled) {
				failed = true;
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		} finally {
			setLoginBusy(false);
			setLoginAnswerBusy(false);
			setLoginInput("");
			setLogin(null);
			loginWindow.current?.close();
			loginWindow.current = null;
			loginAttempt.current = null;
			// Cancel changes no settings: avoid a transient error row and needless reloading.
			if (!attempt.cancelled) void reload(failed);
		}
	}

	async function answerLogin(value: string | undefined): Promise<void> {
		if (!login) return;
		if (value === undefined) {
			if (loginAttempt.current) loginAttempt.current.cancelled = true;
			await window.loom.chatCancelLogin();
			return;
		}
		if (loginAnswerBusy) return;
		setLoginAnswerBusy(true);
		try {
			await window.loom.chatLoginResponse(value);
			setLoginInput("");
		} catch (cause) {
			setLoginAnswerBusy(false);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function addBuiltin(entry: ChatProviderCatalogEntry): Promise<void> {
		if (!view) return;
		await save({ upsert: [{ kind: "builtin", id: entry.id, enabled: true }] });
	}

	async function saveCustom(provider: ChatCustomProviderConfig): Promise<boolean> {
		if (!view) return false;
		const original = customEditor?.provider;
		const fields = original ? changedFields(original, provider) : provider;
		const patch: ChatProviderPatch = { ...fields, id: provider.id };
		if (original && fields.modelEnabled) patch.modelEnabled = Object.fromEntries(
			Object.entries(fields.modelEnabled).filter(([id, enabled]) => original.modelEnabled?.[id] !== enabled),
		);
		if (original?.name && !provider.name) patch.clearName = true;
		const saved = await save({ upsert: [patch] });
		if (saved) setCustomEditor(null);
		return saved;
	}

	async function removeProvider(providerId: string): Promise<void> {
		if (!view) return;
		await save({ remove: [providerId] });
	}

	async function setModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<void> {
		if (!view) return;
		await save({ upsert: [{ id: providerId, modelEnabled: { [modelId]: enabled } }] });
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
		<fieldset className="settings-slot settings-chat-form" aria-label={t.settings.chat.title}>
			<div className="settings-slot-head"><span className="settings-slot-title">{t.settings.chat.title}</span></div>
			<p>{t.settings.chat.lead}</p>
			{error && <div className="session-error">{error}</div>}

				{view.config.providers.map((provider) => {
					const auth = authByProvider.get(provider.id);
					const catalogEntry = catalog.find((entry) => entry.id === provider.id);
					const models = modelsByProvider.get(provider.id) ?? [];
					const authError = auth?.error === "auth_not_configured" ? t.settings.chat.authMissing : t.settings.chat.authCheckFailed;
					const statusError = view.refreshErrors[provider.id] ? t.settings.chat.catalogRefreshFailed : !auth?.configured ? authError : undefined;
					const status = !provider.enabled ? "idle" : statusError ? "error" : "ok";
					const providerName = provider.name ?? catalogEntry?.name ?? provider.id;
					const modelsCollapsed = collapsedModels.has(provider.id);
					return (
						<div key={provider.id} className="settings-chat-provider">
							<div className="settings-chat-provider-head">
								{models.length > 0 ? (
									<button
										type="button"
										className="settings-chat-provider-toggle"
										aria-expanded={!modelsCollapsed}
										aria-label={`${modelsCollapsed ? t.settings.chat.expandModels : t.settings.chat.collapseModels}: ${providerName}`}
										onClick={() => setCollapsedModels((current) => {
											const next = new Set(current);
											if (!next.delete(provider.id)) next.add(provider.id);
											return next;
										})}
									>
										<svg className="settings-chat-provider-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
											<path d="M6 4.5 9.5 8 6 11.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
										</svg>
										<span className="settings-chat-provider-name">{providerName}</span>
										<span className="settings-chat-provider-count">{models.length}</span>
									</button>
								) : (
									<span className="settings-chat-provider-name">{providerName}</span>
								)}
								<SettingsStatus
									status={status}
									error={statusError}
									label={status === "idle" ? t.settings.chat.providerDisabled : status === "ok" ? t.settings.chat.authConfigured : view.refreshErrors[provider.id] ? t.settings.chat.providerProblem : t.settings.chat.authProblem}
									errorTitle={t.settings.chat.providerProblem}
									dotOnly
								/>
							</div>
							{models.length > 0 ? (modelsCollapsed ? null : (
								<table className="settings-chat-models">
									<thead>
										<tr>
											<th scope="col">{t.settings.chat.modelsCol}</th>
											<th scope="col">{t.settings.chat.enabledCol}</th>
										</tr>
									</thead>
									<tbody>
										{models.map((model) => {
											return (
												<tr key={model.id}>
													<td title={`${model.provider} / ${model.id} · ${model.contextWindow.toLocaleString()} ctx · ${model.maxTokens.toLocaleString()} max`}>
														{model.name}
													</td>
													<td>
														<label className="settings-switch">
															<input
																type="checkbox"
																role="switch"
																aria-label={t.settings.chat.enableModel(model.name)}
																checked={provider.modelEnabled?.[model.id] !== false}
																disabled={busy || loginBusy || !!customEditor || !provider.enabled}
																onChange={(event) => void setModelEnabled(model.provider, model.id, event.target.checked)}
															/>
															<span className="settings-switch-ui" aria-hidden="true" />
														</label>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							)) : (
								<p>{t.settings.chat.noModels}</p>
							)}
							{customEditor?.id === provider.id && (
								<SettingsChatCustom key={customEditor.id} {...customEditor} busy={busy || loginBusy} onSave={saveCustom} onCancel={() => setCustomEditor(null)} />
							)}
							<div className="settings-chat-provider-actions">
								{(provider.kind === "custom" || catalogEntry?.apiKeyAuth) && (
									<button type="button" disabled={busy || loginBusy || !!customEditor || !provider.enabled} onClick={() => void startLogin(provider.id, "api_key")}>
										{t.settings.chat.signInApiKey}
									</button>
								)}
								{catalogEntry?.oauthAuth && (auth?.configured && auth.type === "oauth" ? (
									<button type="button" disabled={busy || loginBusy || !!customEditor} onClick={() => void signOut(provider.id, provider.name ?? catalogEntry?.name ?? provider.id)}>
										{t.settings.chat.signOut}
									</button>
								) : (
									<button type="button" disabled={busy || loginBusy || !!customEditor || !provider.enabled} onClick={() => void startLogin(provider.id, "oauth")}>
										{t.settings.chat.signInOauth}
									</button>
								))}
								{provider.kind === "custom" && (
									<button type="button" disabled={busy || loginBusy || !!customEditor} onClick={() => setCustomEditor({ id: provider.id, provider: structuredClone(provider) })}>
										{t.common.edit}
									</button>
								)}
								<button type="button" disabled={busy || loginBusy || !!customEditor} onClick={() => void removeProvider(provider.id)}>
									{t.settings.chat.removeProvider}
								</button>
							</div>
						</div>
					);
				})}

				<div className="settings-chat-add">
					<select
						disabled={busy || loginBusy || !!customEditor}
						value=""
						onChange={(event) => {
							if (event.target.value === "__custom__") {
								setError(null);
								setCustomEditor({ id: `custom-${crypto.randomUUID()}` });
								return;
							}
							const entry = catalog.find((row) => row.id === event.target.value);
							if (entry) void addBuiltin(entry);
						}}
						aria-label={t.settings.chat.addProvider}
					>
						<option value="">{t.settings.chat.addProvider}</option>
						<option value="__custom__">{t.settings.chat.custom}</option>
						{availableBuiltin.map((entry) => (
							<option key={entry.id} value={entry.id}>{entry.name}</option>
						))}
					</select>
					<button type="button" disabled={busy || loginBusy || !!customEditor} onClick={() => void run(async () => setView(await window.loom.chatRefresh()))}>
						{busy ? t.settings.chat.refreshing : t.settings.chat.refresh}
					</button>
				</div>
				{customEditor && !customEditor.provider && (
					<SettingsChatCustom key={customEditor.id} {...customEditor} busy={busy || loginBusy} onSave={saveCustom} onCancel={() => setCustomEditor(null)} />
				)}
				{view.config.providers.length === 0 && <p className="settings-path">{t.settings.chat.notConfigured}</p>}

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
						{login.prompt.type === "secret" && (
							<SettingsSecretInput
								key={`${login.prompt.providerId}:${login.prompt.authType}:${login.prompt.message}`}
								label={login.prompt.authType === "api_key" ? t.settings.apiKey : login.prompt.message}
								value={loginInput}
								disabled={loginAnswerBusy}
								placeholder={login.prompt.placeholder ?? ""}
								autoComplete="off"
								autoFocus
								onChange={(event) => setLoginInput(event.target.value)}
								onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void answerLogin(loginInput); } }}
							/>
						)}
						{(login.prompt.type === "text" || login.prompt.type === "manual_code") && (
							<input
								type="text"
								value={loginInput}
								disabled={loginAnswerBusy}
								placeholder={login.prompt.placeholder ?? (login.prompt.type === "manual_code" ? t.settings.chat.enterCode : "")}
								autoComplete="off"
								autoFocus
								onChange={(event) => setLoginInput(event.target.value)}
								onKeyDown={(event) => { if (event.key === "Enter") void answerLogin(loginInput); }}
							/>
						)}
						{login.prompt.type === "select" && (
							<select autoFocus disabled={loginAnswerBusy} defaultValue="" onChange={(event) => { if (event.target.value) void answerLogin(event.target.value); }}>
								<option value="" disabled>{t.settings.chat.selectMethod}</option>
								{login.prompt.options.map((option) => (
									<option key={option.id} value={option.id}>{option.label}</option>
								))}
							</select>
						)}
						{login.prompt.type === "device_code" && (
							<p className="settings-path">{login.prompt.userCode} — {login.prompt.verificationUri}</p>
						)}
						<div className="settings-actions settings-login-actions">
							<button type="button" onClick={() => void answerLogin(undefined)}>{t.settings.chat.loginCancel}</button>
							{(login.prompt.type === "text" || login.prompt.type === "secret" || login.prompt.type === "manual_code") && (
								<button className="primary-button" type="button" disabled={loginAnswerBusy} onClick={() => void answerLogin(loginInput)}>{t.settings.chat.loginAnswer}</button>
							)}
						</div>
					</div>
				</div>
			)}
		</fieldset>
	);
}
