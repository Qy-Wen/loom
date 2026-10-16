import { useState } from "react";
import { type McpServerDraft, type McpServerStatus, type McpSettingsView } from "../../shared/mcp-settings.ts";
import { useLocale } from "../locale.tsx";
import { SettingsSwitch, type ProbeState } from "./settings-switch.tsx";

interface SettingsMcpProps {
	view: McpSettingsView;
	onChange: (servers: McpServerDraft[]) => void;
	onStatus: (status: McpServerStatus) => void;
	onSave: (index: number) => Promise<McpSettingsView | undefined>;
	onRemove: (index: number) => Promise<boolean>;
}

type LocalProbe = { state: ProbeState; error?: string };

function statusFor(view: McpSettingsView, id: string) {
	return view.status.find((row) => row.id === id);
}

function probeFromStatus(server: McpServerDraft, status: McpServerStatus | undefined): LocalProbe {
	if (!server.enabled) return { state: "idle" };
	if (!status) return { state: "idle" };
	if (status.error) return { state: "error", error: status.error };
	return { state: "ok" };
}

function hasAdvanced(server: McpServerDraft): boolean {
	if (server.transport === "http") return Boolean(server.headersText.trim());
	return Boolean(server.envText.trim() || server.cwd.trim());
}

export function SettingsMcp({ view, onChange, onStatus, onSave, onRemove }: SettingsMcpProps): React.JSX.Element {
	const [busy, setBusy] = useState<Record<number, boolean>>({});
	const [local, setLocal] = useState<Record<number, LocalProbe>>({});
	const [advanced, setAdvanced] = useState<Record<number, boolean>>({});

	function patch(index: number, next: Partial<McpServerDraft>): void {
		onChange(view.servers.map((server, i) => i === index ? { ...server, ...next } : server));
		if ("enabled" in next) return;
		setLocal((current) => {
			const copy = { ...current };
			delete copy[index];
			return copy;
		});
	}

	async function saveServer(index: number, server = view.servers[index]!): Promise<void> {
		setBusy((current) => ({ ...current, [index]: true }));
		setLocal((current) => ({ ...current, [index]: { state: server.enabled ? "checking" : "idle" } }));
		try {
			const saved = await onSave(index);
			if (!saved) { setLocal((current) => ({ ...current, [index]: { state: "idle" } })); return; }
			const status = saved.status.find((row) => row.id === server.id.trim());
			if (status) onStatus(status);
			setLocal((current) => ({ ...current, [index]: probeFromStatus(server, status) }));
		} finally { setBusy((current) => ({ ...current, [index]: false })); }
	}

	async function setEnabled(index: number, enabled: boolean): Promise<void> {
		const server = { ...view.servers[index]!, enabled };
		onChange(view.servers.map((row, i) => i === index ? server : row));
		await saveServer(index, server);
	}

	const { t } = useLocale();
	return (
		<div className="settings-form settings-form-docked">
			<div className="settings-form-scroll">
			<p className="settings-path">{t.settings.configFile(view.path)}</p>
			{view.servers.length === 0 && (
				<div className="empty">{t.settings.mcpEmpty}</div>
			)}
			{view.servers.map((server, index) => {
				const status = statusFor(view, server.id.trim());
				const probe = local[index] ?? probeFromStatus(server, status);
				const title = server.id.trim() || t.settings.server(index + 1);
				return (
					<fieldset key={index} className="settings-slot" aria-label={title} disabled={Object.values(busy).some(Boolean)}>
						<div className="settings-slot-head">
							<input
								className="settings-slot-name"
								value={server.id}
								onChange={(event) => patch(index, { id: event.target.value })}
								placeholder={t.settings.name}
								autoComplete="off"
								aria-label={t.settings.serverName}
							/>
							<SettingsSwitch
								checked={server.enabled}
								disabled={busy[index]}
								label={t.settings.enableSlot(title)}
								status={probe.state}
								error={probe.error}
								onChange={(enabled) => void setEnabled(index, enabled)}
							/>
						</div>
						<div className="settings-kind" role="radiogroup" aria-label={t.settings.serverType}>
							<label className={server.transport === "stdio" ? "is-active" : undefined}>
								<input
									type="radio"
									name={`mcp-kind-${index}`}
									checked={server.transport === "stdio"}
									onChange={() => patch(index, { transport: "stdio" })}
								/>
								{t.settings.local}
							</label>
							<label className={server.transport === "http" ? "is-active" : undefined}>
								<input
									type="radio"
									name={`mcp-kind-${index}`}
									checked={server.transport === "http"}
									onChange={() => patch(index, { transport: "http" })}
								/>
								{t.settings.remote}
							</label>
						</div>
						{server.transport === "http" ? (
							<label>
								{t.settings.url}
								<input
									value={server.url}
									onChange={(event) => patch(index, { url: event.target.value })}
									placeholder="https://example.com/mcp"
									autoComplete="off"
								/>
							</label>
						) : (
							<>
								<label>
									{t.settings.command}
									<input
										value={server.command}
										onChange={(event) => patch(index, { command: event.target.value })}
										placeholder="npx"
										autoComplete="off"
									/>
								</label>
								<label>
									{t.settings.args}
									<textarea
										value={server.argsText}
										onChange={(event) => patch(index, { argsText: event.target.value })}
										placeholder={"-y\npackage-name"}
										rows={2}
									/>
								</label>
							</>
						)}
						<details
							className="settings-advanced"
							open={advanced[index] ?? hasAdvanced(server)}
							onToggle={(event) => {
								const nextOpen = event.currentTarget.open;
								setAdvanced((current) => ({ ...current, [index]: nextOpen }));
							}}
						>
							<summary>{t.settings.advanced}</summary>
							<div className="settings-advanced-body">
								{server.transport === "http" ? (
									<label>
										{t.settings.headers}
										<textarea
											value={server.headersText}
											onChange={(event) => patch(index, { headersText: event.target.value })}
											placeholder={"Authorization=Bearer …"}
											rows={2}
										/>
									</label>
								) : (
									<>
										<label>
											{t.settings.env}
											<textarea
												value={server.envText}
												onChange={(event) => patch(index, { envText: event.target.value })}
												placeholder={"API_KEY=…"}
												rows={2}
											/>
										</label>
										<label>
											{t.settings.cwd}
											<input
												value={server.cwd}
												onChange={(event) => patch(index, { cwd: event.target.value })}
												autoComplete="off"
											/>
										</label>
									</>
								)}
							</div>
						</details>
						{probe.state === "checking" && <p className="settings-path">{t.settings.connecting}</p>}
						{probe.state === "ok" && (
							<p className="settings-status-ok">
								{status?.tools.length ? t.settings.connectedTools(status.tools.join(", ")) : t.settings.connectedNoTools}
							</p>
						)}
						<div className="settings-actions">
							<button type="button" onClick={() => {
								setBusy((current) => ({ ...current, [index]: true }));
								void onRemove(index).then((removed) => { if (removed) { setLocal({}); setAdvanced({}); } }).finally(() => setBusy({}));
							}}>{t.common.remove}</button>
							<button className="primary-button" type="button" onClick={() => void saveServer(index)}>{t.settings.saveServer}</button>
						</div>
					</fieldset>
				);
			})}
			</div>
		</div>
	);
}
