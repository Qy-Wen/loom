import { Fragment, useEffect, useRef, useState } from "react";
import type {
	Asset,
	AssetEnrichment,
	AssetLinkView,
	AssetPropertyValue,
	AssetRelationsResult,
	AssetTag,
	PropertyDefinition,
	Tag,
	TextEmbedStatus,
	ImageVlmStatus,
	VideoVlmStatus,
	AudioWriteupStatus,
} from "@loom/core";
import type { AssetRefAttachment, HarnessContextUsage, HarnessSessionRecord, HarnessSessionSummary as SessionSummary, LoomTranscriptMessage } from "@loom/agent";
import { formatBytes } from "../assets/asset-utils.ts";
import { displayPropertyValue } from "../workbench/table-values.ts";
import { EnrichmentDetails } from "./enrichment-details.tsx";
import { ImageVlmDetails } from "./image-vlm-details.tsx";
import { TextEmbedDetails } from "./text-embed-details.tsx";
import { SuggestInput } from "./suggest-input.tsx";
import { TagEditor } from "./tag-editor.tsx";
import { SessionBar } from "./session-bar.tsx";
import { SessionChat } from "./session-chat.tsx";
import { AgentPermissionProvider } from "./agent-permission.tsx";
import { AssetOpenProvider, LibraryAssetsProvider } from "./asset-open.tsx";
import { ToolCallViews } from "./tool-call-views.tsx";

export type SidePanelTab = "agent" | "details";

interface SidePanelProps {
	libraryRoot: string | null;
	activeTab: SidePanelTab;
	asset: Asset | null;
	properties: PropertyDefinition[];
	propertyValues: AssetPropertyValue[];
	tags: Tag[];
	assetTags: AssetTag[];
	onAddTag: (assetId: string, name: string) => Promise<void>;
	onRemoveTag: (assetId: string, tagId: string) => Promise<void>;
	onChangeTab: (tab: SidePanelTab) => void;
	enrichment: AssetEnrichment | undefined;
	textEmbed: TextEmbedStatus | undefined;
	embedding: boolean;
	onEmbed: () => void;
	imageVlm: ImageVlmStatus | undefined;
	videoVlm: VideoVlmStatus | undefined;
	audioWriteup: AudioWriteupStatus | undefined;
	describing: boolean;
	onDescribe: () => void;
	relations: AssetRelationsResult;
	assets: Asset[];
	relationTypes: string[];
	onSelectAsset: (assetId: string) => void;
	onOpenAsset: (assetId: string) => void;
	composerAttach: AssetRefAttachment | null;
	onComposerAttachApplied: () => void;
	onCreateRelation: (fromAssetId: string, toAssetId: string, type: string) => Promise<void>;
	onRemoveRelation: (relationId: string) => Promise<void>;
}

export function SidePanel({
	libraryRoot,
	activeTab,
	asset,
	properties,
	propertyValues,
	tags,
	assetTags,
	onAddTag,
	onRemoveTag,
	onChangeTab,
	enrichment,
	textEmbed,
	embedding,
	onEmbed,
	imageVlm,
	videoVlm,
	audioWriteup,
	describing,
	onDescribe,
	relations,
	assets,
	relationTypes,
	onSelectAsset,
	onOpenAsset,
	composerAttach,
	onComposerAttachApplied,
	onCreateRelation,
	onRemoveRelation,
}: SidePanelProps): React.JSX.Element {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	sessionIdRef.current = sessionId;
	const [sessionMessages, setSessionMessages] = useState<LoomTranscriptMessage[]>([]);
	const [sessionContext, setSessionContext] = useState<HarnessContextUsage | null>(null);
	const [composerDraft, setComposerDraft] = useState<{ sessionId: string; text: string } | null>(null);
	const [sessionBusy, setSessionBusy] = useState(false);
	const [sessionError, setSessionError] = useState<string | null>(null);

	function applyRecord(record: HarnessSessionRecord): void {
		setSessionMessages(record.messages);
		setSessionContext(record.context ?? null);
	}

	useEffect(() => {
		if (!libraryRoot) {
			setSessions([]);
			setSessionId(null);
			setSessionMessages([]);
			setSessionContext(null);
			setComposerDraft(null);
			setSessionError(null);
			return;
		}
		let active = true;
		void syncSessions();
		const unsubscribe = window.loom.onSessionsChanged((list) => {
			setSessions(list);
			const current = sessionIdRef.current;
			if (!current || !list.some((session) => session.id === current)) return;
			void window.loom.getSession(current).then((record) => {
				if (active && sessionIdRef.current === current) applyRecord(record);
			}).catch(() => undefined);
		});
		return () => {
			active = false;
			unsubscribe();
		};
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
				applyRecord(record);
				return;
			}
			const created = await window.loom.createSession();
			setSessions(await window.loom.listSessions());
			setSessionId(created.id);
			applyRecord(created);
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
			applyRecord(created);
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
			applyRecord(record);
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
					applyRecord(record);
				} else {
					const created = await window.loom.createSession();
					setSessionId(created.id);
					applyRecord(created);
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
							<AssetOpenProvider onOpen={onOpenAsset}>
							<LibraryAssetsProvider assets={assets}>
							<AgentPermissionProvider>
							<div className="agent-chat">
								<ToolCallViews libraryRoot={libraryRoot} />
								<SessionChat
									threadId={sessionId}
									messages={sessionMessages}
									context={sessionContext}
									composerDraft={composerDraft?.sessionId === sessionId ? composerDraft.text : null}
									onComposerDraftApplied={() => setComposerDraft(null)}
									composerAttach={composerAttach}
									onComposerAttachApplied={onComposerAttachApplied}
									onSessionRecord={applyRecord}
									onForked={(record, text) => {
										setSessionId(record.id);
										applyRecord(record);
										setComposerDraft({ sessionId: record.id, text });
										void window.loom.listSessions().then(setSessions).catch(() => undefined);
									}}
								/>
							</div>
							</AgentPermissionProvider>
							</LibraryAssetsProvider>
							</AssetOpenProvider>
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
							<EnrichmentDetails enrichment={enrichment} />
							<PropertySummary
								assetId={asset.assetId}
								properties={properties}
								propertyValues={propertyValues}
							/>
						</dl>
					) : (
						<div className="empty no-padding">Select an asset to see its properties.</div>
					)}
				</section>
				{asset && (
					<section>
						<TagEditor
							assetId={asset.assetId}
							tags={tags}
							assetTags={assetTags}
							onAdd={(name) => onAddTag(asset.assetId, name)}
							onRemove={(tagId) => onRemoveTag(asset.assetId, tagId)}
						/>
					</section>
				)}
				{asset && (
					<ImageVlmDetails
						status={imageVlm?.supported ? imageVlm : videoVlm?.supported ? videoVlm : audioWriteup}
						describing={describing}
						onDescribe={onDescribe}
					/>
				)}
				{asset && (
					<TextEmbedDetails
						status={textEmbed}
						embedding={embedding}
						onEmbed={onEmbed}
					/>
				)}
				<section className="relations-section">
					<RelationsEditor
						asset={asset}
						assets={assets}
						relations={relations}
						relationTypes={relationTypes}
						onSelect={onSelectAsset}
						onCreate={onCreateRelation}
						onRemove={onRemoveRelation}
					/>
				</section>
			</div>
		</aside>
	);
}

function PropertySummary({
	assetId,
	properties,
	propertyValues,
}: {
	assetId: string;
	properties: PropertyDefinition[];
	propertyValues: AssetPropertyValue[];
}): React.JSX.Element | null {
	const values = new Map(
		propertyValues.filter((value) => value.assetId === assetId).map((value) => [value.propertyId, value.value]),
	);
	const filled = properties.filter((property) => values.has(property.propertyId));
	if (filled.length === 0) return null;
	return (
		<>
			{filled.map((property, index) => (
				<Fragment key={property.propertyId}>
					<dt className={index === 0 ? "file-property" : undefined}>{property.name}</dt>
					<dd className={index === 0 ? "file-property" : undefined}>{displayPropertyValue(values.get(property.propertyId), property.type)}</dd>
				</Fragment>
			))}
		</>
	);
}

function RelationsEditor({
	asset,
	assets,
	relations,
	relationTypes,
	onSelect,
	onCreate,
	onRemove,
}: {
	asset: Asset | null;
	assets: Asset[];
	relations: AssetRelationsResult;
	relationTypes: string[];
	onSelect: (assetId: string) => void;
	onCreate: (fromAssetId: string, toAssetId: string, type: string) => Promise<void>;
	onRemove: (relationId: string) => Promise<void>;
}): React.JSX.Element {
	const others = assets
		.filter((item) => item.assetId !== asset?.assetId)
		.sort((a, b) => a.filename.localeCompare(b.filename) || a.relativePath.localeCompare(b.relativePath));
	const relationGroups = groupLinks(relations.links);
	const [form, setForm] = useState<{ type: string; toAssetId: string; direction: "out" | "in" } | null>(null);
	const [typeOpen, setTypeOpen] = useState(false);
	const [assetQuery, setAssetQuery] = useState("");
	const [assetOpen, setAssetOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const assetQueryNormalized = assetQuery.trim().toLowerCase();
	const assetMatches = others.filter((item) => {
		if (!assetQueryNormalized) return true;
		return item.filename.toLowerCase().includes(assetQueryNormalized)
			|| item.relativePath.toLowerCase().includes(assetQueryNormalized);
	});
	const selectedAsset = others.find((item) => item.assetId === form?.toAssetId);

	useEffect(() => {
		setForm(null);
		setTypeOpen(false);
		setAssetQuery("");
		setAssetOpen(false);
		setError(null);
	}, [asset?.assetId]);

	async function submit(): Promise<void> {
		if (!asset || !form?.type.trim() || !form.toAssetId || saving) return;
		setSaving(true);
		setError(null);
		const fromAssetId = form.direction === "out" ? asset.assetId : form.toAssetId;
		const toAssetId = form.direction === "out" ? form.toAssetId : asset.assetId;
		try {
			await onCreate(fromAssetId, toAssetId, form.type);
			setForm(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<div className="property-heading">
				<div className="section-label">Relations</div>
				{asset && others.length > 0 && (
					<button
						className="icon-button"
						type="button"
						aria-label="Add relation"
						title="Add relation"
						onClick={() => {
							setForm({ type: "", toAssetId: "", direction: "out" });
							setTypeOpen(false);
							setAssetQuery("");
							setAssetOpen(false);
							setError(null);
						}}
					>+</button>
				)}
			</div>
			{asset && form && (
				<div className="property-definition-form relation-form">
					<div className="relation-type-row">
						<SuggestInput
							autoFocus
							openOnFocus={false}
							value={form.type}
							open={typeOpen}
							suggestions={relationTypes}
							placeholder="Relationship type"
							showLabel="Show relationship types"
							hideLabel="Hide relationship types"
							onChange={(type) => setForm({ ...form, type })}
							onOpenChange={setTypeOpen}
						/>
						<button
							type="button"
							className="relation-direction"
							aria-label={form.direction === "out" ? "This file points to the other" : "The other file points to this"}
							onClick={() => setForm({ ...form, direction: form.direction === "out" ? "in" : "out" })}
						>{form.direction === "out" ? "→" : "←"}</button>
					</div>
					<div className="relation-asset-picker">
						<button
							type="button"
							className="relation-asset-toggle"
							aria-expanded={assetOpen}
							onClick={() => setAssetOpen((current) => !current)}
						>
							<span>{selectedAsset?.filename ?? "Choose a file"}</span>
						</button>
						{assetOpen && (
							<div className="relation-asset-menu">
								<input
									autoFocus
									placeholder="Search files"
									value={assetQuery}
									onChange={(event) => setAssetQuery(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Escape") setAssetOpen(false);
									}}
								/>
								<ul>
									{assetMatches.map((item) => (
										<li key={item.assetId}>
											<button
												type="button"
												className={item.assetId === form.toAssetId ? "selected" : undefined}
												title={item.relativePath}
												onClick={() => {
													setForm({ ...form, toAssetId: item.assetId });
													setAssetOpen(false);
													setAssetQuery("");
												}}
											>
												{item.filename}
											</button>
										</li>
									))}
								</ul>
								{assetMatches.length === 0 && <div className="empty no-padding">No matching files.</div>}
							</div>
						)}
					</div>
					{error && <div className="relation-form-error">{error}</div>}
					<div className="property-form-actions">
						<button type="button" onClick={() => { setForm(null); setError(null); }}>Cancel</button>
						<button
							type="button"
							disabled={!form.type.trim() || !form.toAssetId || saving}
							onClick={() => void submit()}
						>{saving ? "Adding…" : "Add"}</button>
					</div>
				</div>
			)}
			{asset && relationGroups.length > 0 ? (
				relationGroups.map((group) => (
					<RelationGroup
						key={group.type}
						label={group.type}
						items={group.items}
						showDirection
						onSelect={onSelect}
						onRemove={onRemove}
					/>
				))
			) : (
				<div className="empty no-padding">{asset ? "No relations yet." : "Select an asset to see its relations."}</div>
			)}
		</>
	);
}

function RelationGroup({
	label,
	items,
	showDirection,
	onSelect,
	onRemove,
}: {
	label: string;
	items: AssetLinkView[];
	showDirection?: boolean;
	onSelect: (assetId: string) => void;
	onRemove: (relationId: string) => Promise<void>;
}): React.JSX.Element | null {
	if (items.length === 0) return null;
	return (
		<div className="relation-group">
			<div className="relation-group-label">{label}</div>
			<ul className="relation-list">
				{items.map((item) => (
					<li key={item.relationId}>
						<button type="button" onClick={() => onSelect(item.asset.assetId)}>
							<span className="relation-filename">
								{showDirection ? `${item.direction === "out" ? "→" : "←"} ` : ""}
								{item.asset.filename}
							</span>
						</button>
						<button
							className="icon-button"
							type="button"
							title="Remove relation"
							onClick={() => void onRemove(item.relationId)}
						>×</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function groupLinks(links: AssetLinkView[]): { type: string; items: AssetLinkView[] }[] {
	const groups = new Map<string, AssetLinkView[]>();
	for (const link of links) {
		const items = groups.get(link.relationType) ?? [];
		items.push(link);
		groups.set(link.relationType, items);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([type, items]) => ({ type, items }));
}
