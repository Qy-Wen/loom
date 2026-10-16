import { useEffect, useRef, useState } from "react";
import type { AgentStatsView } from "../../shared/agent-stats.ts";
import { emptyMcpServerDraft, type McpServerDraft, type McpServerStatus, type McpSettingsView } from "../../shared/mcp-settings.ts";
import type { ModelSettingsDraft, ModelSlotId } from "../../shared/model-settings.ts";
import { modelRequestUrl } from "../../shared/model-request-url.ts";
import { instructionCharacterCount, INSTRUCTIONS_CHAR_LIMIT } from "../../shared/agent-instructions.ts";
import type { GeneralSettings } from "../../shared/general-settings.ts";
import { useLocale } from "../locale.tsx";
import { SettingsAgent } from "./settings-agent.tsx";
import { SettingsGeneral } from "./settings-general.tsx";
import { SettingsMcp } from "./settings-mcp.tsx";
import { SettingsChat } from "./settings-chat.tsx";
import { SettingsModels } from "./settings-models.tsx";
import { SettingsStats } from "./settings-stats.tsx";
import { SettingsSaveQueue } from "./settings-save-queue.ts";

type SettingsTab = "general" | "models" | "mcp" | "agent" | "stats";
const TAB_IDS: SettingsTab[] = ["general", "models", "mcp", "agent", "stats"];

export function SettingsPage({ onClose }: { onClose: () => void }): React.JSX.Element {
	const { t, commitLanguage } = useLocale();
	const [tab, setTab] = useState<SettingsTab>("models");
	const [draft, setDraft] = useState<ModelSettingsDraft | null>(null);
	const [mcp, setMcp] = useState<McpSettingsView | null>(null);
	const [stats, setStats] = useState<AgentStatsView | null>(null);
	const [instructions, setInstructions] = useState<string | null>(null);
	const [sandboxEnabled, setSandboxEnabled] = useState<boolean | null>(null);
	const [general, setGeneral] = useState<GeneralSettings | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [resetting, setResetting] = useState(false);
	const queue = useRef(new SettingsSaveQueue());
	const modelDraft = useRef<ModelSettingsDraft | null>(null);
	const savedModels = useRef<ModelSettingsDraft | null>(null);
	const mcpDraft = useRef<McpServerDraft[]>([]);
	const savedMcp = useRef<McpServerDraft[]>([]);
	const mcpIdentities = useRef<(string | undefined)[]>([]);
	const generalDraft = useRef<GeneralSettings | null>(null);
	const instructionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pendingInstructions = useRef<string | undefined>(undefined);
	const closeOnBackdrop = useRef(false);
	const closing = useRef(false);
	// External tool updates must not overwrite text currently being edited.
	const dirtyModels = useRef(new Set<ModelSlotId>());
	const dirtyMcp = useRef(false);
	const dirtyInstructions = useRef(false);

	async function persist<T>(operation: () => Promise<T>): Promise<T | undefined> {
		try {
			const result = await queue.current.run(operation);
			setError(null);
			return result;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return undefined;
		}
	}

	async function saveInstructions(): Promise<boolean> {
		clearTimeout(instructionTimer.current);
		instructionTimer.current = undefined;
		const value = pendingInstructions.current;
		if (value === undefined) return true;
		if (instructionCharacterCount(value) > INSTRUCTIONS_CHAR_LIMIT) {
			setError(t.settings.instructionsTooLong(INSTRUCTIONS_CHAR_LIMIT));
			return false;
		}
		pendingInstructions.current = undefined;
		const saved = await persist(() => window.loom.saveAgentInstructions(value));
		if (saved === undefined) {
			if (pendingInstructions.current === undefined) pendingInstructions.current = value;
			return false;
		}
		if (pendingInstructions.current === undefined) dirtyInstructions.current = false;
		return true;
	}

	async function close(): Promise<void> {
		if (closing.current) return;
		closing.current = true;
		try {
			if (!await saveInstructions()) return;
			await queue.current.flush();
			onClose();
		} finally { closing.current = false; }
	}

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector(".settings-login-overlay")) void close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const [models, mcpView, statsView, instructionsText, sandbox, generalView] = await Promise.all([
					window.loom.getModelSettings(), window.loom.getMcpSettings(), window.loom.getAgentStats(),
					window.loom.getAgentInstructions(), window.loom.getAgentSandbox(), window.loom.getGeneralSettings(),
				]);
				if (cancelled) return;
				savedModels.current = models;
				const nextModels = { ...models };
				for (const id of dirtyModels.current) if (modelDraft.current) nextModels[id] = { ...models[id], ...modelDraft.current[id] };
				modelDraft.current = nextModels; setDraft(nextModels);
				savedMcp.current = mcpView.servers;
				if (!dirtyMcp.current) {
					mcpDraft.current = mcpView.servers;
					mcpIdentities.current = mcpView.servers.map((row) => row.id);
					setMcp(mcpView);
				} else setMcp((current) => current ? { ...current, status: mcpView.status } : mcpView);
				setStats(statsView);
				if (!dirtyInstructions.current) setInstructions(instructionsText);
				setSandboxEnabled(sandbox);
				generalDraft.current = generalView; setGeneral(generalView);
				commitLanguage(generalView.language);
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			}
		};
		void load();
		const unsubscribe = window.loom.onSettingsChanged(() => { void queue.current.flush().then(load); });
		return () => { cancelled = true; unsubscribe(); clearTimeout(instructionTimer.current); };
	}, [commitLanguage]);

	useEffect(() => {
		if (tab === "stats") void window.loom.getAgentStats().then(setStats).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, [tab]);

	function patchModel(id: ModelSlotId, patch: Partial<ModelSettingsDraft[ModelSlotId]>): void {
		if (!modelDraft.current) return;
		dirtyModels.current.add(id);
		modelDraft.current = { ...modelDraft.current, [id]: { ...modelDraft.current[id], ...patch } };
		setDraft(modelDraft.current);
	}

	async function commitModel(id: ModelSlotId, patch?: Partial<ModelSettingsDraft[ModelSlotId]>): Promise<boolean> {
		if (!modelDraft.current || !savedModels.current || (!patch && !dirtyModels.current.has(id))) return false;
		const slot = { ...modelDraft.current[id], ...patch };
		const onlyDisable = patch?.enabled === false;
		try {
			if (!onlyDisable && slot.baseUrl.trim()) modelRequestUrl(slot.baseUrl);
			if (slot.enabled && (!slot.baseUrl.trim() || !slot.model.trim())) throw new Error(t.settings.modelNeedsEndpoint);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
		const saved = await persist(async () => {
			const committedSlot = onlyDisable ? { ...savedModels.current![id], enabled: false } : slot;
			const result = await window.loom.saveModelSettings({ ...savedModels.current!, [id]: committedSlot });
			savedModels.current = result;
			return result;
		});
		if (!saved) return false;
		if (patch) {
			modelDraft.current = { ...modelDraft.current, [id]: { ...modelDraft.current[id], ...patch } };
			setDraft(modelDraft.current);
		}
		if (JSON.stringify(modelDraft.current[id]) === JSON.stringify(onlyDisable ? saved[id] : slot)) dirtyModels.current.delete(id);
		return true;
	}

	function patchMcp(servers: McpServerDraft[]): void {
		dirtyMcp.current = true; mcpDraft.current = servers;
		setMcp((current) => current ? { ...current, servers } : current);
	}

	async function commitMcp(index: number): Promise<McpSettingsView | undefined> {
		const server = { ...mcpDraft.current[index] };
		const originalId = mcpIdentities.current[index];
		const saved = await persist(async () => {
			const next = [...savedMcp.current];
			if (next.some((row) => row.id !== originalId && row.id === server.id.trim())) throw new Error(t.settings.duplicateServer);
			const position = next.findIndex((row) => row.id === originalId);
			if (position < 0) next.push(server); else next[position] = server;
			const result = await window.loom.saveMcpSettings(next);
			savedMcp.current = result.servers;
			return result;
		});
		if (saved) {
			mcpIdentities.current[index] = server.id.trim();
			if (JSON.stringify(mcpDraft.current[index]) === JSON.stringify(server)) {
				mcpDraft.current = mcpDraft.current.map((row, i) => i === index ? saved.servers.find((item) => item.id === server.id.trim())! : row);
			}
			dirtyMcp.current = JSON.stringify(mcpDraft.current) !== JSON.stringify(saved.servers);
			setMcp((current) => current ? { ...current, servers: mcpDraft.current, status: saved.status } : saved);
		}
		return saved;
	}

	async function removeMcp(index: number): Promise<boolean> {
		const originalId = mcpIdentities.current[index];
		if (originalId !== undefined) {
			const saved = await persist(async () => {
				const result = await window.loom.saveMcpSettings(savedMcp.current.filter((row) => row.id !== originalId));
				savedMcp.current = result.servers; return result;
			});
			if (!saved) return false;
			setMcp((current) => current ? { ...current, status: saved.status } : saved);
		}
		mcpIdentities.current.splice(index, 1);
		patchMcp(mcpDraft.current.filter((_, i) => i !== index));
		dirtyMcp.current = JSON.stringify(mcpDraft.current) !== JSON.stringify(savedMcp.current);
		return true;
	}

	function patchMcpStatus(status: McpServerStatus): void {
		setMcp((current) => current ? { ...current, status: [...current.status.filter((row) => row.id !== status.id), status] } : current);
	}

	function patchGeneral(patch: Partial<GeneralSettings>): void {
		if (!generalDraft.current) return;
		const next = { ...generalDraft.current, ...patch };
		generalDraft.current = next; setGeneral(next);
		void persist(() => window.loom.saveGeneralSettings(next)).then((saved) => {
			if (saved && generalDraft.current === next) commitLanguage(saved.language);
		});
	}

	function patchInstructions(value: string): void {
		setInstructions(value); dirtyInstructions.current = true; pendingInstructions.current = value;
		clearTimeout(instructionTimer.current);
		instructionTimer.current = setTimeout(() => { void saveInstructions(); }, 500);
	}

	function patchSandbox(enabled: boolean): void {
		setSandboxEnabled(enabled);
		void persist(() => window.loom.saveAgentSandbox(enabled));
	}

	async function resetStats(): Promise<void> {
		setResetting(true);
		const saved = await persist(() => window.loom.resetAgentStats());
		if (saved) setStats(saved);
		setResetting(false);
	}

	return (
		<div className="settings-overlay" role="presentation" onPointerDown={(event) => {
			closeOnBackdrop.current = event.target === event.currentTarget;
		}} onClick={(event) => {
			if (event.target === event.currentTarget && closeOnBackdrop.current) void close();
			closeOnBackdrop.current = false;
		}}>
			<div className="settings-dialog" role="dialog" aria-labelledby="settings-title">
				<div className="settings-header">
					<h2 id="settings-title">{t.settings.title}</h2>
					<button className="icon-button" type="button" onClick={() => void close()} aria-label={t.settings.close}>×</button>
				</div>
				<div className="settings-tabs" role="tablist" aria-label={t.settings.sections}>
					{TAB_IDS.map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : undefined} onClick={() => {
						void saveInstructions(); setTab(id);
					}}>{t.settings.tabs[id]}</button>)}
				</div>
				<p className="settings-lead">{t.settings.leads[tab]}</p>
				{error && <div className="session-error" role="alert">{error}</div>}
				<div className="settings-pane-form">
					<div className="settings-pane">
						{tab === "general" && (general ? <SettingsGeneral value={general} onChange={patchGeneral} /> : <div className="empty">{t.common.loading}</div>)}
						{tab === "models" && <div className="settings-models-scroll">
							<SettingsChat />
							{draft ? <SettingsModels draft={draft} onChange={patchModel} onCommit={commitModel} /> : <div className="empty">{t.common.loading}</div>}
						</div>}
						{tab === "mcp" && (mcp ? <SettingsMcp view={mcp} onChange={patchMcp} onStatus={patchMcpStatus} onSave={commitMcp} onRemove={removeMcp} /> : <div className="empty">{t.common.loading}</div>)}
						{tab === "agent" && (instructions !== null && sandboxEnabled !== null ? <SettingsAgent sandboxEnabled={sandboxEnabled} instructions={instructions} onSandboxChange={patchSandbox} onInstructionsChange={patchInstructions} /> : <div className="empty">{t.common.loading}</div>)}
						{tab === "stats" && (stats ? <SettingsStats stats={stats} resetting={resetting} onReset={() => void resetStats()} /> : <div className="empty">{t.common.loading}</div>)}
					</div>
					{tab === "mcp" && <div className="settings-actions settings-dialog-actions">
						<button type="button" onClick={() => { mcpIdentities.current.push(undefined); patchMcp([...mcpDraft.current, emptyMcpServerDraft()]); }}>{t.settings.addServer}</button>
					</div>}
				</div>
			</div>
		</div>
	);
}
