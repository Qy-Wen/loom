import { useEffect, useRef, useState } from "react";
import type { AgentStatsView } from "../../shared/agent-stats.ts";
import { emptyMcpServerDraft, type McpServerDraft, type McpServerStatus, type McpSettingsView } from "../../shared/mcp-settings.ts";
import type { ModelSettingsDraft, ModelSlotId } from "../../shared/model-settings.ts";
import { instructionCharacterCount, INSTRUCTIONS_CHAR_LIMIT } from "../../shared/agent-instructions.ts";
import type { GeneralSettings } from "../../shared/general-settings.ts";
import { useLocale } from "../locale.tsx";
import { SettingsAgent } from "./settings-agent.tsx";
import { SettingsGeneral } from "./settings-general.tsx";
import { SettingsMcp } from "./settings-mcp.tsx";
import { SettingsChat } from "./settings-chat.tsx";
import { SettingsModels } from "./settings-models.tsx";
import { SettingsStats } from "./settings-stats.tsx";

type SettingsTab = "general" | "models" | "mcp" | "agent" | "stats";

const TAB_IDS: SettingsTab[] = ["general", "models", "mcp", "agent", "stats"];

interface SettingsPageProps {
	onClose: () => void;
}

export function SettingsPage({ onClose }: SettingsPageProps): React.JSX.Element {
	const { t, previewLanguage, restoreLanguage, commitLanguage } = useLocale();
	const [tab, setTab] = useState<SettingsTab>("models");
	const [draft, setDraft] = useState<ModelSettingsDraft | null>(null);
	const [mcp, setMcp] = useState<McpSettingsView | null>(null);
	const [stats, setStats] = useState<AgentStatsView | null>(null);
	const [instructions, setInstructions] = useState<string | null>(null);
	const [sandboxEnabled, setSandboxEnabled] = useState<boolean | null>(null);
	const [general, setGeneral] = useState<GeneralSettings | null>(null);
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
		let cancelled = false;
		const load = () => {
			void (async () => {
				try {
					const [models, mcpView, statsView, instructionsText, sandbox, generalView] = await Promise.all([
						window.loom.getModelSettings(),
						window.loom.getMcpSettings(),
						window.loom.getAgentStats(),
						window.loom.getAgentInstructions(),
						window.loom.getAgentSandbox(),
						window.loom.getGeneralSettings(),
					]);
					if (cancelled) return;
					setDraft({
						embedding: { baseUrl: models.embedding.baseUrl, model: models.embedding.model, apiKey: models.embedding.apiKey, enabled: models.embedding.enabled },
						rerank: { baseUrl: models.rerank.baseUrl, model: models.rerank.model, apiKey: models.rerank.apiKey, enabled: models.rerank.enabled },
						vlm: { baseUrl: models.vlm.baseUrl, model: models.vlm.model, apiKey: models.vlm.apiKey, enabled: models.vlm.enabled },
						audio: { baseUrl: models.audio.baseUrl, model: models.audio.model, apiKey: models.audio.apiKey, enabled: models.audio.enabled },
					});
					setMcp(mcpView);
					setStats(statsView);
					setInstructions(instructionsText);
					setSandboxEnabled(sandbox);
					setGeneral(generalView);
				} catch (cause) {
					if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
				}
			})();
		};
		load();
		const unsubscribe = window.loom.onSettingsChanged(() => {
			if (!cancelled) load();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	function patchModel(id: ModelSlotId, patch: Partial<ModelSettingsDraft[ModelSlotId]>): void {
		setDraft((current) => current ? { ...current, [id]: { ...current[id], ...patch } } : current);
	}

	function patchMcp(servers: McpServerDraft[]): void {
		setMcp((current) => current ? { ...current, servers } : current);
	}

	function patchMcpStatus(status: McpServerStatus): void {
		setMcp((current) => {
			if (!current) return current;
			const rest = current.status.filter((row) => row.id !== status.id);
			const server = current.servers.find((row) => row.id.trim() === status.id);
			if (!status.id || (server && !server.enabled)) return { ...current, status: rest };
			return { ...current, status: [...rest, status] };
		});
	}

	useEffect(() => {
		if (!general) return;
		previewLanguage(general.language);
	}, [general?.language, previewLanguage]);

	useEffect(() => restoreLanguage, [restoreLanguage]);

	async function saveAll(): Promise<void> {
		if (!draft || !mcp || !general || instructions === null || sandboxEnabled === null || saving) return;
		if (instructionCharacterCount(instructions) > INSTRUCTIONS_CHAR_LIMIT) {
			setError(t.settings.instructionsTooLong(INSTRUCTIONS_CHAR_LIMIT));
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const saved = await window.loom.saveGeneralSettings(general);
			commitLanguage(saved.language);
			await Promise.all([
				window.loom.saveModelSettings(draft),
				window.loom.saveMcpSettings(mcp.servers),
				window.loom.saveAgentInstructions(instructions),
				window.loom.saveAgentSandbox(sandboxEnabled),
			]);
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
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
					<h2 id="settings-title">{t.settings.title}</h2>
					<button className="icon-button" type="button" onClick={onClose} aria-label={t.settings.close}>×</button>
				</div>
				<div className="settings-tabs" role="tablist" aria-label={t.settings.sections}>
					{TAB_IDS.map((id) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={tab === id}
							className={tab === id ? "is-active" : undefined}
							onClick={() => setTab(id)}
						>
							{t.settings.tabs[id]}
						</button>
					))}
				</div>
				<p className="settings-lead">{t.settings.leads[tab]}</p>
				{error && <div className="session-error">{error}</div>}
				<form
					className="settings-pane-form"
					onSubmit={(event) => {
						event.preventDefault();
						void saveAll();
					}}
				>
				<div className="settings-pane">
				{tab === "general" && (general
					? (
						<SettingsGeneral
							value={general}
							onChange={(patch) => setGeneral((current) => current ? { ...current, ...patch } : current)}
						/>
					)
					: <div className="empty">{t.common.loading}</div>)}
				{tab === "models" && (
					<div className="settings-models-scroll">
						<SettingsChat />
						{draft
							? <SettingsModels draft={draft} onChange={patchModel} />
							: <div className="empty">{t.common.loading}</div>}
					</div>
				)}
				{tab === "mcp" && (mcp
					? <SettingsMcp view={mcp} onChange={patchMcp} onStatus={patchMcpStatus} />
					: <div className="empty">{t.common.loading}</div>)}
				{tab === "agent" && (instructions !== null && sandboxEnabled !== null
					? (
						<SettingsAgent
							sandboxEnabled={sandboxEnabled}
							instructions={instructions}
							onSandboxChange={setSandboxEnabled}
							onInstructionsChange={setInstructions}
						/>
					)
					: <div className="empty">{t.common.loading}</div>)}
				{tab === "stats" && (stats
					? <SettingsStats stats={stats} resetting={saving} onReset={() => void resetStats()} />
					: <div className="empty">{t.common.loading}</div>)}
				</div>
				<div className="settings-actions settings-dialog-actions">
					{tab === "mcp" && (
						<button
							className="settings-add"
							type="button"
							onClick={() => patchMcp([...(mcp?.servers ?? []), emptyMcpServerDraft()])}
						>
							{t.settings.addServer}
						</button>
					)}
					<button type="button" onClick={onClose}>{t.common.cancel}</button>
					<button
						className="primary-button"
						type="submit"
						disabled={saving || !draft || !mcp || !general || instructions === null || sandboxEnabled === null || instructionCharacterCount(instructions) > INSTRUCTIONS_CHAR_LIMIT}
					>
						{t.common.save}
					</button>
				</div>
				</form>
			</div>
		</div>
	);
}
