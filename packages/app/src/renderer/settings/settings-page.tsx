import { useEffect, useRef, useState } from "react";
import type { AgentStatsView } from "../../shared/agent-stats.ts";
import type { McpServerDraft, McpSettingsView } from "../../shared/mcp-settings.ts";
import type { ModelSettingsDraft, ModelSlotId } from "../../shared/model-settings.ts";
import { SettingsMcp } from "./settings-mcp.tsx";
import { SettingsModels } from "./settings-models.tsx";
import { SettingsStats } from "./settings-stats.tsx";

type SettingsTab = "models" | "mcp" | "stats";

const TABS: { id: SettingsTab; label: string }[] = [
	{ id: "models", label: "Models" },
	{ id: "mcp", label: "MCP" },
	{ id: "stats", label: "Stats" },
];

const LEAD: Record<SettingsTab, string> = {
	models: "Local or remote is the same form: URL, API key, and model. Hosted APIs need a key; local servers often do not. Keys stay in the app, not in the library.",
	mcp: "Any stdio or HTTP MCP server. The id becomes the tool prefix (id__tool). Nothing is hardcoded to a vendor.",
	stats: "Lifetime Chat usage for this app. Prompt-cache hit rate is the number that matters for prefix stability.",
};

interface SettingsPageProps {
	onClose: () => void;
}

export function SettingsPage({ onClose }: SettingsPageProps): React.JSX.Element {
	const [tab, setTab] = useState<SettingsTab>("models");
	const [draft, setDraft] = useState<ModelSettingsDraft | null>(null);
	const [mcp, setMcp] = useState<McpSettingsView | null>(null);
	const [stats, setStats] = useState<AgentStatsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const closeOnBackdrop = useRef(false);

	useEffect(() => {
		function onKey(event: KeyboardEvent): void {
			if (event.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		if (tab !== "stats") return;
		void window.loom.getAgentStats().then(setStats).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
		});
	}, [tab]);

	useEffect(() => {
		void (async () => {
			try {
				const [models, mcpView, statsView] = await Promise.all([
					window.loom.getModelSettings(),
					window.loom.getMcpSettings(),
					window.loom.getAgentStats(),
				]);
				setDraft({
					chat: { baseUrl: models.chat.baseUrl, model: models.chat.model, apiKey: models.chat.apiKey },
					embedding: { baseUrl: models.embedding.baseUrl, model: models.embedding.model, apiKey: models.embedding.apiKey },
					rerank: { baseUrl: models.rerank.baseUrl, model: models.rerank.model, apiKey: models.rerank.apiKey },
					vlm: { baseUrl: models.vlm.baseUrl, model: models.vlm.model, apiKey: models.vlm.apiKey },
				});
				setMcp(mcpView);
				setStats(statsView);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
	}, []);

	function patchModel(id: ModelSlotId, field: "baseUrl" | "model" | "apiKey", value: string): void {
		setDraft((current) => current ? { ...current, [id]: { ...current[id], [field]: value } } : current);
	}

	function patchMcp(servers: McpServerDraft[]): void {
		setMcp((current) => current ? { ...current, servers } : current);
	}

	async function saveModels(): Promise<void> {
		if (!draft) return;
		setSaving(true);
		setError(null);
		try {
			await window.loom.saveModelSettings(draft);
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	async function saveMcp(): Promise<void> {
		if (!mcp) return;
		setSaving(true);
		setError(null);
		try {
			setMcp(await window.loom.saveMcpSettings(mcp.servers));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	async function resetStats(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			setStats(await window.loom.resetAgentStats());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	function onBackdropPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
		closeOnBackdrop.current = event.target === event.currentTarget;
	}

	function onBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
		if (event.target === event.currentTarget && closeOnBackdrop.current) onClose();
		closeOnBackdrop.current = false;
	}

	return (
		<div
			className="settings-overlay"
			role="presentation"
			onPointerDown={onBackdropPointerDown}
			onClick={onBackdropClick}
		>
			<div
				className="settings-dialog"
				role="dialog"
				aria-labelledby="settings-title"
			>
				<div className="settings-header">
					<h2 id="settings-title">Settings</h2>
					<button className="icon-button" type="button" onClick={onClose} aria-label="Close settings">×</button>
				</div>
				<div className="settings-tabs" role="tablist" aria-label="Settings sections">
					{TABS.map((item) => (
						<button
							key={item.id}
							type="button"
							role="tab"
							aria-selected={tab === item.id}
							className={tab === item.id ? "is-active" : undefined}
							onClick={() => setTab(item.id)}
						>
							{item.label}
						</button>
					))}
				</div>
				<p className="settings-lead">{LEAD[tab]}</p>
				{error && <div className="session-error">{error}</div>}
				<div className="settings-pane">
				{tab === "models" && (draft
					? (
						<SettingsModels
							draft={draft}
							saving={saving}
							onChange={patchModel}
							onCancel={onClose}
							onSave={() => void saveModels()}
						/>
					)
					: <div className="empty">Loading…</div>)}
				{tab === "mcp" && (mcp
					? <SettingsMcp view={mcp} saving={saving} onChange={patchMcp} onSave={() => void saveMcp()} />
					: <div className="empty">Loading…</div>)}
				{tab === "stats" && (stats
					? <SettingsStats stats={stats} resetting={saving} onReset={() => void resetStats()} />
					: <div className="empty">Loading…</div>)}
				</div>
			</div>
		</div>
	);
}
