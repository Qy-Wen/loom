import { useEffect, useState } from "react";
import type {
	Asset,
	AssetEnrichment,
	AssetPropertyValue,
	PropertyDefinition,
	PropertyType,
	PropertyValue,
	LoomTranscriptMessage,
	SessionSummary,
} from "@loom/core";
import { formatBytes } from "./asset-utils.ts";
import { EnrichmentDetails } from "./enrichment-details.tsx";
import { PropertyEditor } from "./property-editor.tsx";
import { SessionBar } from "./session-bar.tsx";
import { SessionChat } from "./session-chat.tsx";
import { ToolCallViews } from "./tool-call-views.tsx";

export type SidePanelTab = "agent" | "details";

interface SidePanelProps {
	libraryRoot: string | null;
	activeTab: SidePanelTab;
	asset: Asset | null;
	properties: PropertyDefinition[];
	propertyValues: AssetPropertyValue[];
	onChangeTab: (tab: SidePanelTab) => void;
	onCreateProperty: (name: string, type: PropertyType) => Promise<void>;
	onUpdateProperty: (propertyId: string, name: string, type: PropertyType) => Promise<void>;
	onRemoveProperty: (propertyId: string) => Promise<void>;
	onSetPropertyValue: (assetId: string, propertyId: string, value: PropertyValue) => Promise<void>;
	onRemovePropertyValue: (assetId: string, propertyId: string) => Promise<void>;
	enrichment: AssetEnrichment | undefined;
	analyzing: boolean;
	onAnalyze: () => void;
}

export function SidePanel({
	libraryRoot,
	activeTab,
	asset,
	properties,
	propertyValues,
	onChangeTab,
	onCreateProperty,
	onUpdateProperty,
	onRemoveProperty,
	onSetPropertyValue,
	onRemovePropertyValue,
	enrichment,
	analyzing,
	onAnalyze,
}: SidePanelProps): React.JSX.Element {
	const selectedValues = asset
		? propertyValues.filter((value) => value.assetId === asset.assetId)
		: [];
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [sessionMessages, setSessionMessages] = useState<LoomTranscriptMessage[]>([]);
	const [sessionBusy, setSessionBusy] = useState(false);
	const [sessionError, setSessionError] = useState<string | null>(null);

	useEffect(() => {
		if (!libraryRoot) {
			setSessions([]);
			setSessionId(null);
			setSessionMessages([]);
			setSessionError(null);
			return;
		}
		void syncSessions();
		return window.loom.onSessionsChanged(setSessions);
	}, [libraryRoot]);

	async function refreshSessions(): Promise<SessionSummary[]> {
		const list = await window.loom.listSessions();
		setSessions(list);
		return list;
	}

	async function syncSessions(preferId?: string): Promise<void> {
		setSessionBusy(true);
		setSessionError(null);
		try {
			const list = await refreshSessions();
			const open = list.filter((session) => session.status === "open");
			const next = (preferId && list.some((session) => session.id === preferId))
				? preferId
				: (open[0]?.id ?? null);
			if (next) {
				if (list.find((session) => session.id === next)?.status === "archived") {
					await window.loom.unarchiveSession(next);
				}
				const record = await window.loom.openSession(next);
				setSessions(await window.loom.listSessions());
				setSessionId(next);
				setSessionMessages(record.messages);
				return;
			}
			const created = await window.loom.createSession();
			setSessions(await window.loom.listSessions());
			setSessionId(created.id);
			setSessionMessages(created.messages);
		} catch (cause) {
			setSessionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSessionBusy(false);
		}
	}

	async function createSession(): Promise<void> {
		setSessionBusy(true);
		setSessionError(null);
		try {
			const created = await window.loom.createSession();
			setSessions(await window.loom.listSessions());
			setSessionId(created.id);
			setSessionMessages(created.messages);
		} catch (cause) {
			setSessionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSessionBusy(false);
		}
	}

	async function selectSession(id: string): Promise<void> {
		if (id === sessionId) return;
		setSessionBusy(true);
		setSessionError(null);
		try {
			const selected = sessions.find((session) => session.id === id);
			if (selected?.status === "archived") await window.loom.unarchiveSession(id);
			const record = await window.loom.openSession(id);
			setSessions(await window.loom.listSessions());
			setSessionId(id);
			setSessionMessages(record.messages);
		} catch (cause) {
			setSessionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSessionBusy(false);
		}
	}

	async function archiveSession(id: string): Promise<void> {
		setSessionBusy(true);
		setSessionError(null);
		try {
			await window.loom.archiveSession(id);
			await syncSessions();
		} catch (cause) {
			setSessionError(cause instanceof Error ? cause.message : String(cause));
			setSessionBusy(false);
		}
	}

	async function deleteSession(id: string): Promise<void> {
		if (!window.confirm("Delete this session? This cannot be undone.")) return;
		setSessionBusy(true);
		setSessionError(null);
		try {
			if (id === sessionId) {
				const fallback = sessions.find((session) => session.id !== id && session.status === "open");
				if (fallback) {
					const record = await window.loom.openSession(fallback.id);
					setSessionId(fallback.id);
					setSessionMessages(record.messages);
				} else {
					const created = await window.loom.createSession();
					setSessionId(created.id);
					setSessionMessages(created.messages);
				}
			}
			await window.loom.deleteSession(id);
			setSessions(await window.loom.listSessions());
		} catch (cause) {
			setSessionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSessionBusy(false);
		}
	}

	return (
		<aside className="side-panel">
			<div className="panel-tabs">
				<button
					className={activeTab === "agent" ? "active" : ""}
					type="button"
					onClick={() => onChangeTab("agent")}
				>Agent</button>
				<button
					className={activeTab === "details" ? "active" : ""}
					type="button"
					onClick={() => onChangeTab("details")}
				>Details</button>
			</div>

			<div className={`panel-content agent-content ${activeTab === "agent" ? "active" : ""}`}>
				{libraryRoot ? (
					<>
						<SessionBar
							sessions={sessions}
							currentId={sessionId}
							busy={sessionBusy}
							onCreate={() => void createSession()}
							onSelect={(id) => void selectSession(id)}
							onArchive={(id) => void archiveSession(id)}
							onUnarchive={(id) => void selectSession(id)}
							onDelete={(id) => void deleteSession(id)}
							onRefresh={() => void refreshSessions().catch(() => undefined)}
						/>
						{sessionError && <div className="session-error">{sessionError}</div>}
						{sessionId ? (
							<div className="agent-chat">
								<ToolCallViews />
								<SessionChat threadId={sessionId} messages={sessionMessages} />
							</div>
						) : (
							<div className="empty">Starting a session…</div>
						)}
					</>
				) : (
					<div className="empty">Open a library to start a conversation.</div>
				)}
			</div>

			<div className={`panel-content details-content ${activeTab === "details" ? "active" : ""}`}>
				<section>
					<div className="section-label">File</div>
					{asset ? (
						<dl className="properties">
							<dt>Type</dt><dd>{asset.type}</dd>
							<dt>Size</dt><dd>{formatBytes(asset.size)}</dd>
							<dt>Modified</dt><dd>{new Date(asset.modifiedAt).toLocaleString()}</dd>
							<dt>Asset ID</dt><dd title={asset.assetId}>{asset.assetId}</dd>
						</dl>
					) : (
						<div className="empty no-padding">Select an asset to see its properties.</div>
					)}
				</section>
				{asset && (
					<EnrichmentDetails
						enrichment={enrichment}
						analyzing={analyzing}
						onAnalyze={onAnalyze}
					/>
				)}
				{asset && (
					<section>
						<PropertyEditor
							asset={asset}
							properties={properties}
							values={selectedValues}
							onCreateProperty={onCreateProperty}
							onUpdateProperty={onUpdateProperty}
							onRemoveProperty={onRemoveProperty}
							onSetValue={(propertyId, value) =>
								onSetPropertyValue(asset.assetId, propertyId, value)}
							onRemoveValue={(propertyId) =>
								onRemovePropertyValue(asset.assetId, propertyId)}
						/>
					</section>
				)}
				<section className="relations-section">
					<div className="section-label">Relations</div>
					<div className="empty no-padding">No relations yet.</div>
				</section>
			</div>
		</aside>
	);
}
