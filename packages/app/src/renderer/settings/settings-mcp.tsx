import { emptyMcpServerDraft, type McpServerDraft, type McpSettingsView } from "../../shared/mcp-settings.ts";

interface SettingsMcpProps {
	view: McpSettingsView;
	saving: boolean;
	onChange: (servers: McpServerDraft[]) => void;
	onSave: () => void;
}

function statusFor(view: McpSettingsView, id: string) {
	return view.status.find((row) => row.id === id);
}

export function SettingsMcp({ view, saving, onChange, onSave }: SettingsMcpProps): React.JSX.Element {
	function patch(index: number, next: Partial<McpServerDraft>): void {
		onChange(view.servers.map((server, i) => i === index ? { ...server, ...next } : server));
	}

	return (
		<form
			className="settings-form"
			onSubmit={(event) => {
				event.preventDefault();
				onSave();
			}}
		>
			<p className="settings-path">Config file: {view.path}</p>
			{view.servers.length === 0 && (
				<div className="empty">No MCP servers. Add a stdio or HTTP server, then save to connect.</div>
			)}
			{view.servers.map((server, index) => {
				const status = statusFor(view, server.id.trim());
				return (
					<fieldset key={index} className="settings-slot">
						<legend>{server.id.trim() || `Server ${index + 1}`}</legend>
						<label>
							Id
							<input
								value={server.id}
								onChange={(event) => patch(index, { id: event.target.value })}
								placeholder="my-server"
								autoComplete="off"
							/>
						</label>
						<fieldset className="settings-transport">
							<legend>Transport</legend>
							<label>
								<input
									type="radio"
									name={`mcp-transport-${index}`}
									checked={server.transport === "stdio"}
									onChange={() => patch(index, { transport: "stdio" })}
								/>
								stdio
							</label>
							<label>
								<input
									type="radio"
									name={`mcp-transport-${index}`}
									checked={server.transport === "http"}
									onChange={() => patch(index, { transport: "http" })}
								/>
								HTTP
							</label>
						</fieldset>
						{server.transport === "http" ? (
							<>
								<label>
									URL
									<input
										value={server.url}
										onChange={(event) => patch(index, { url: event.target.value })}
										placeholder="https://example.com/mcp"
										autoComplete="off"
									/>
								</label>
								<label>
									Headers (KEY=value, one per line)
									<textarea
										value={server.headersText}
										onChange={(event) => patch(index, { headersText: event.target.value })}
										rows={3}
									/>
								</label>
							</>
						) : (
							<>
								<label>
									Command
									<input
										value={server.command}
										onChange={(event) => patch(index, { command: event.target.value })}
										placeholder="npx"
										autoComplete="off"
									/>
								</label>
								<label>
									Args (one per line)
									<textarea
										value={server.argsText}
										onChange={(event) => patch(index, { argsText: event.target.value })}
										rows={3}
									/>
								</label>
								<label>
									Env (KEY=value, one per line)
									<textarea
										value={server.envText}
										onChange={(event) => patch(index, { envText: event.target.value })}
										rows={3}
									/>
								</label>
								<label>
									cwd
									<input
										value={server.cwd}
										onChange={(event) => patch(index, { cwd: event.target.value })}
										autoComplete="off"
									/>
								</label>
							</>
						)}
						{status?.error && <p className="settings-status-error">{status.error}</p>}
						{status && !status.error && (
							<p className="settings-status-ok">
								{status.tools.length ? `Connected: ${status.tools.join(", ")}` : "Connected (no tools)"}
							</p>
						)}
						<div className="settings-actions">
							<button type="button" onClick={() => onChange(view.servers.filter((_, i) => i !== index))}>
								Remove
							</button>
						</div>
					</fieldset>
				);
			})}
			<div className="settings-actions">
				<button type="button" onClick={() => onChange([...view.servers, emptyMcpServerDraft()])}>
					Add server
				</button>
				<button className="primary-button" type="submit" disabled={saving}>
					{saving ? "Connecting…" : "Save and connect"}
				</button>
			</div>
		</form>
	);
}
