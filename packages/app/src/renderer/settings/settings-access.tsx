import { useEffect, useRef, useState } from "react";
import type { McpServiceView } from "../../shared/mcp-service.ts";
import { useLocale } from "../locale.tsx";
import { SettingsSecretInput } from "./settings-secret-input.tsx";
import { SettingsStatus } from "./settings-switch.tsx";

export function useMcpService() {
	const [view, setView] = useState<McpServiceView | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let alive = true; let received = false;
		const stop = window.loom.onMcpServiceChanged((value) => { received = true; setView(value); });
		void window.loom.getMcpService().then((value) => { if (alive && !received) setView(value); }).catch((error) => { if (alive) setError(String(error)); });
		return () => { alive = false; stop(); };
	}, []);
	return { view, setView, error, setError };
}

export function SettingsAccess(): React.JSX.Element {
	const { t } = useLocale(); const text = t.settings.external;
	const { view, setView, error, setError } = useMcpService();
	const [port, setPort] = useState<string | null>(null);
	const [tokenDraft, setTokenDraft] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const changed = !!view && (Number(port ?? view.port) !== view.port || (tokenDraft ?? view.token).trim() !== view.token);
	const [copiedConfiguration, setCopiedConfiguration] = useState<Pick<McpServiceView, "url" | "token"> | null>(null);
	const copied = !!view && copiedConfiguration?.url === view.url && copiedConfiguration?.token === view.token;
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(copyTimer.current), []);
	async function persist(enabled: boolean): Promise<McpServiceView> {
		const configuration = await window.loom.saveMcpService({ enabled, port: Number(port ?? view!.port), token: tokenDraft ?? view!.token });
		setView(configuration); setPort(null); setTokenDraft(null);
		return configuration;
	}
	function generateToken() {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		setTokenDraft(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
		setCopiedConfiguration(null);
	}
	async function copyConfiguration() {
		if (!view || busy) return;
		clearTimeout(copyTimer.current);
		setBusy(true); setCopiedConfiguration(null); setError(null);
		try {
			// Copy the applied configuration, including any edits, without enabling the service.
			const configuration = changed ? await persist(view.enabled) : view;
			await navigator.clipboard.writeText(JSON.stringify({ mcpServers: { loom: { type: "http", url: configuration.url, ...(configuration.token ? { headers: { Authorization: `Bearer ${configuration.token}` } } : {}) } } }, null, 2));
			setCopiedConfiguration({ url: configuration.url, token: configuration.token });
			copyTimer.current = setTimeout(() => setCopiedConfiguration(null), 1500);
		} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	}
	async function save(enabled: boolean) {
		if (!view) return;
		setBusy(true); setError(null); setCopiedConfiguration(null);
		try { await persist(enabled); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	}
	return <div className="settings-form">
		{error && <p role="alert" className="session-error">{error}</p>}
		{view && <>
			<section className="settings-slot" aria-label={text.title}>
				<div className="settings-slot-head">
					<span className="settings-slot-title">{text.title}</span>
					<span className="settings-slot-controls">
						<SettingsStatus status={view.error ? "error" : view.running ? "ok" : "idle"} error={view.error} label={view.error ? t.settings.connectionError : view.running ? text.running : text.stopped} dotOnly />
						<label className="settings-switch"><input type="checkbox" role="switch" aria-label={text.enable} checked={view.enabled} disabled={busy} onChange={(event) => void save(event.target.checked)} /><span className="settings-switch-ui" aria-hidden="true" /></label>
					</span>
				</div>
				<p>{text.note}</p>
				{view.error && <p role="alert" className="session-error">{view.error}</p>}
				<label>{text.port}<input aria-label={text.port} type="number" min="1024" max="65535" value={port ?? view.port} onChange={(event) => { setPort(event.target.value); setCopiedConfiguration(null); }} disabled={busy} /></label>
				<div className="settings-access-token">
					<label>
						{text.token}
						<SettingsSecretInput label={text.token} value={tokenDraft ?? view.token} maxLength={512} placeholder={text.tokenPlaceholder} disabled={busy} autoComplete="off" onChange={(event) => { setTokenDraft(event.target.value); setCopiedConfiguration(null); }} />
					</label>
					<div className="settings-actions"><button type="button" disabled={busy} onClick={generateToken}>{text.generate}</button></div>
				</div>
				<dl className="settings-connection-info">
					<div>
						<dt>{text.url}</dt>
						<dd><code>{view.url}</code></dd>
					</div>
				</dl>
				<div className="settings-actions">
					<button type="button" className={copied ? "is-copied" : undefined} disabled={busy} aria-live="polite" onClick={() => void copyConfiguration()}>
						{copied && <span aria-hidden="true">✓ </span>}{copied ? text.copied : text.copy}
					</button>
					<button className="primary-button" type="button" disabled={busy || !changed} onClick={() => void save(view.enabled)}>{text.save}</button>
				</div>
			</section>
			<section className="settings-slot" aria-label={text.history}><h3>{text.history}</h3>{view.tasks.length === 0 && <p>{text.empty}</p>}
				{view.tasks.map((task) => <article className="external-call" key={task.id}><strong>{task.tool}</strong><span>{text.status[task.status]}</span><p>{task.client} · {task.library}</p>{task.error && <p>{task.error}</p>}<details><summary>{task.id}</summary><pre>{JSON.stringify(task.args, null, 2)}</pre></details>{!task.finishedAt && <button type="button" onClick={() => void window.loom.cancelExternalTool(task.id).catch((error) => setError(String(error)))}>{text.cancel}</button>}</article>)}
			</section>
		</>}
	</div>;
}
