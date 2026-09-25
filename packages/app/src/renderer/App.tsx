import { useEffect, useMemo, useRef, useState } from "react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import type {
	Asset,
	AssetEnrichment,
	AssetPropertyValue,
	AssetRelation,
	AssetRelationsResult,
	LibraryChange,
	LibrarySnapshot,
	PropertyDefinition,
	PropertyType,
	PropertyValue,
	TextEmbedStatus,
} from "@loom/core";
import type { AgentEndpoint } from "../shared/ipc.ts";
import { sortAssets } from "./assets/asset-utils.ts";
import { useResizableLayout } from "./layout/use-resizable-layout.ts";
import { ancestorFolders, folderSet } from "./library/file-tree.tsx";
import { LibrarySidebar } from "./library/library-sidebar.tsx";
import { SidePanel, type SidePanelTab } from "./panel/side-panel.tsx";
import { SettingsPage } from "./settings/settings-page.tsx";
import { AssetPreview } from "./workbench/asset-preview.tsx";
import { GraphView } from "./workbench/graph-view.tsx";
import { TableView } from "./workbench/table-view.tsx";

const EMPTY_LIBRARY: LibrarySnapshot = { rootPath: null, folders: [], assets: [] };
const EMPTY_RELATIONS: AssetRelationsResult = { generatedFrom: [], generated: [], links: [] };
type WorkbenchView = "library" | "table" | "graph";

function sortProperties(properties: PropertyDefinition[]): PropertyDefinition[] {
	return [...properties].sort((a, b) => a.name.localeCompare(b.name));
}

/** Apply one main-process watcher event without refetching the whole library. */
function applyLibraryChange(current: LibrarySnapshot, change: LibraryChange): LibrarySnapshot {
	if (change.type === "reset") return change.snapshot;
	if (change.type === "error" || change.type === "enrichment" || change.type === "text_embed") return current;
	if (change.type === "remove") {
		return { ...current, assets: current.assets.filter((asset) => asset.assetId !== change.assetId) };
	}
	if (change.type === "folder_upsert") {
		return current.folders.includes(change.relativePath)
			? current
			: { ...current, folders: [...current.folders, change.relativePath].sort() };
	}
	if (change.type === "folder_remove") {
		const prefix = `${change.relativePath}/`;
		return {
			...current,
			folders: current.folders.filter(
				(folder) => folder !== change.relativePath && !folder.startsWith(prefix),
			),
		};
	}
	return {
		...current,
		assets: sortAssets([
			...current.assets.filter((asset) => asset.assetId !== change.asset.assetId),
			change.asset,
		]),
	};
}

export function App(): React.JSX.Element {
	const [endpoint, setEndpoint] = useState<AgentEndpoint | null>(null);
	const [library, setLibrary] = useState<LibrarySnapshot>(EMPTY_LIBRARY);
	const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
	const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
	const [sidePanel, setSidePanel] = useState<SidePanelTab>("agent");
	const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("library");
	const [properties, setProperties] = useState<PropertyDefinition[]>([]);
	const [propertyValues, setPropertyValues] = useState<AssetPropertyValue[]>([]);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [enrichment, setEnrichment] = useState<AssetEnrichment | undefined>();
	const [textEmbed, setTextEmbed] = useState<TextEmbedStatus | undefined>();
	const [relations, setRelations] = useState<AssetRelationsResult>(EMPTY_RELATIONS);
	const [graphEdges, setGraphEdges] = useState<AssetRelation[]>([]);
	const [analyzing, setAnalyzing] = useState(false);
	const [embedding, setEmbedding] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const selectedAssetIdRef = useRef<string | null>(null);
	const {
		shellRef,
		shellStyle,
		beginResize,
		resetLibraryWidth,
		resetSideWidth,
	} = useResizableLayout();

	useEffect(() => {
		void window.loom.getAgentEndpoint().then(setEndpoint).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
		});
		void window.loom.getLibrarySnapshot().then(async (snapshot) => {
			setLibrary(snapshot);
			setCollapsedFolders(folderSet(snapshot));
			if (snapshot.rootPath) {
				const propertySnapshot = await window.loom.getPropertySnapshot();
				setProperties(propertySnapshot.properties);
				setPropertyValues(propertySnapshot.values);
				setGraphEdges(await window.loom.listGraphRelations());
			}
		}).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
		});

		return window.loom.onLibraryChanged((change) => {
			if (change.type === "error") {
				setError(change.message);
				return;
			}
			setLibrary((current) => applyLibraryChange(current, change));
			if (change.type === "remove") {
				setPropertyValues((current) => current.filter((value) => value.assetId !== change.assetId));
			}
			if (change.type === "reset") setCollapsedFolders(folderSet(change.snapshot));
			if (change.type === "folder_upsert") {
				setCollapsedFolders((current) => new Set(current).add(change.relativePath));
			}
			if (change.type === "enrichment" && change.assetId === selectedAssetIdRef.current) {
				void window.loom.getAssetEnrichment(change.assetId).then(setEnrichment).catch(() => undefined);
			}
			if (change.type === "text_embed" && change.assetId === selectedAssetIdRef.current) {
				void window.loom.getTextEmbedStatus(change.assetId).then(setTextEmbed).catch(() => undefined);
			}
			if (change.type === "upsert" || change.type === "remove" || change.type === "reset") {
				void window.loom.listGraphRelations().then(setGraphEdges).catch(() => setGraphEdges([]));
				if (selectedAssetIdRef.current) {
					void window.loom.getAssetRelations(selectedAssetIdRef.current)
						.then(setRelations)
						.catch(() => setRelations(EMPTY_RELATIONS));
				}
			}
		});
	}, []);

	selectedAssetIdRef.current = selectedAssetId;

	useEffect(() => {
		if (workbenchView !== "graph" || !library.rootPath) return;
		void window.loom.listGraphRelations().then(setGraphEdges).catch(() => setGraphEdges([]));
	}, [workbenchView, library.rootPath, library.assets.length]);

	useEffect(() => {
		if (!selectedAssetId) {
			setEnrichment(undefined);
			setTextEmbed(undefined);
			setRelations(EMPTY_RELATIONS);
			return;
		}
		void window.loom.getAssetEnrichment(selectedAssetId).then(setEnrichment).catch(() => {
			setEnrichment(undefined);
		});
		void window.loom.getTextEmbedStatus(selectedAssetId).then(setTextEmbed).catch(() => {
			setTextEmbed(undefined);
		});
		void window.loom.getAssetRelations(selectedAssetId).then(setRelations).catch(() => {
			setRelations(EMPTY_RELATIONS);
		});
	}, [selectedAssetId]);

	const selectedAsset = useMemo(
		() => library.assets.find((asset) => asset.assetId === selectedAssetId) ?? null,
		[library.assets, selectedAssetId],
	);

	useEffect(() => {
		void window.loom.setUiSelection(
			selectedAsset
				? {
					assetId: selectedAsset.assetId,
					path: selectedAsset.relativePath,
					assetType: selectedAsset.type,
				}
				: null,
		);
	}, [selectedAsset]);

	useEffect(() => {
		if (!selectedAsset) return;
		const folders = ancestorFolders(selectedAsset.relativePath);
		if (folders.length === 0) return;
		setCollapsedFolders((current) => {
			let changed = false;
			const next = new Set(current);
			for (const folder of folders) {
				if (next.delete(folder)) changed = true;
			}
			return changed ? next : current;
		});
	}, [selectedAsset]);
	const relationTypes = useMemo(
		() => [...new Set(graphEdges.map((edge) => edge.type).filter((type) => type !== "GENERATED_FROM"))].sort(),
		[graphEdges],
	);

	async function refreshRelations(): Promise<void> {
		setGraphEdges(await window.loom.listGraphRelations());
		if (selectedAssetIdRef.current) {
			setRelations(await window.loom.getAssetRelations(selectedAssetIdRef.current));
		}
	}

	async function createRelation(fromAssetId: string, toAssetId: string, type: string): Promise<void> {
		setError(null);
		try {
			await window.loom.createRelation(fromAssetId, toAssetId, type);
			await refreshRelations();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function removeRelation(relationId: string): Promise<void> {
		setError(null);
		try {
			await window.loom.removeRelation(relationId);
			await refreshRelations();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	function toggleFolder(relativePath: string): void {
		setCollapsedFolders((current) => {
			const next = new Set(current);
			if (next.has(relativePath)) next.delete(relativePath);
			else next.add(relativePath);
			return next;
		});
	}

	async function showAssetContextMenu(asset: Asset): Promise<void> {
		setSelectedAssetId(asset.assetId);
		setError(null);
		try {
			const action = await window.loom.showAssetContextMenu(asset.assetId);
			if (action === "rename") {
				setRenamingAssetId(asset.assetId);
			} else if (action === "duplicate") {
				const duplicate = await window.loom.duplicateAsset(asset.assetId);
				setSelectedAssetId(duplicate.assetId);
			} else if (action === "copy_path") {
				await window.loom.copyAssetPath(asset.assetId);
			} else if (action === "reveal") {
				await window.loom.revealAsset(asset.assetId);
			} else if (action === "trash") {
				const removed = await window.loom.trashAsset(asset.assetId);
				if (removed) setSelectedAssetId(null);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function renameAsset(asset: Asset, stem: string): Promise<void> {
		setError(null);
		try {
			await window.loom.renameAsset(asset.assetId, stem);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRenamingAssetId(null);
		}
	}

	async function analyzeSelected(): Promise<void> {
		if (!selectedAssetId) return;
		setAnalyzing(true);
		setError(null);
		try {
			setEnrichment(await window.loom.analyzeAsset(selectedAssetId));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAnalyzing(false);
		}
	}

	async function embedSelected(): Promise<void> {
		if (!selectedAssetId) return;
		setEmbedding(true);
		setError(null);
		try {
			setTextEmbed(await window.loom.embedAsset(selectedAssetId));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setEmbedding(false);
		}
	}

	async function createProperty(name: string, type: PropertyType): Promise<void> {
		setError(null);
		try {
			const property = await window.loom.createProperty(name, type);
			setProperties((current) => sortProperties([...current, property]));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function updateProperty(propertyId: string, name: string, type: PropertyType): Promise<void> {
		setError(null);
		try {
			const property = await window.loom.updateProperty(propertyId, name, type);
			setProperties((current) => sortProperties(
				current.map((item) => item.propertyId === propertyId ? property : item),
			));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function removeProperty(propertyId: string): Promise<void> {
		setError(null);
		try {
			await window.loom.removeProperty(propertyId);
			setProperties((current) => current.filter((property) => property.propertyId !== propertyId));
			setPropertyValues((current) => current.filter((value) => value.propertyId !== propertyId));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function setPropertyValue(
		assetId: string,
		propertyId: string,
		value: PropertyValue,
	): Promise<void> {
		setError(null);
		try {
			const saved = await window.loom.setAssetProperty(assetId, propertyId, value);
			setPropertyValues((current) => [
				...current.filter((item) => item.assetId !== assetId || item.propertyId !== propertyId),
				saved,
			]);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function removePropertyValue(assetId: string, propertyId: string): Promise<void> {
		setError(null);
		try {
			await window.loom.removeAssetProperty(assetId, propertyId);
			setPropertyValues((current) =>
				current.filter((item) => item.assetId !== assetId || item.propertyId !== propertyId),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function openLibrary(): Promise<void> {
		setOpening(true);
		setError(null);
		try {
			const snapshot = await window.loom.openLibrary();
			if (snapshot) {
				const propertySnapshot = await window.loom.getPropertySnapshot();
				setLibrary(snapshot);
				setSelectedAssetId(null);
				setRenamingAssetId(null);
				setCollapsedFolders(folderSet(snapshot));
				setProperties(propertySnapshot.properties);
				setPropertyValues(propertySnapshot.values);
				setGraphEdges(await window.loom.listGraphRelations());
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setOpening(false);
		}
	}

	if (!endpoint) {
		return <div className="loading">{error ?? "Connecting to Loom agent…"}</div>;
	}

	return (
		<CopilotKitProvider runtimeUrl={endpoint.runtimeUrl} agentId={endpoint.agentId}>
			<div className="app">
				<header className="topbar">
					<span className="brand">Loom</span>
					<nav className="view-switcher" aria-label="Workspace views">
						<button
							className={workbenchView === "library" ? "active" : ""}
							type="button"
							onClick={() => setWorkbenchView("library")}
						>Library</button>
						<button type="button" disabled>Gallery</button>
						<button
							className={workbenchView === "table" ? "active" : ""}
							type="button"
							onClick={() => setWorkbenchView("table")}
						>Table</button>
						<button
							className={workbenchView === "graph" ? "active" : ""}
							type="button"
							onClick={() => setWorkbenchView("graph")}
						>Graph</button>
					</nav>
					<div className="topbar-spacer" />
					<button className="topbar-settings" type="button" onClick={() => setSettingsOpen(true)}>
						Settings
					</button>
				</header>

				{error && <div className="error-banner">{error}</div>}

				<div className="shell" ref={shellRef} style={shellStyle}>
					<LibrarySidebar
						library={library}
						opening={opening}
						selectedAssetId={selectedAssetId}
						renamingAssetId={renamingAssetId}
						collapsedFolders={collapsedFolders}
						onOpenLibrary={() => void openLibrary()}
						onToggleFolder={toggleFolder}
						onSelectAsset={setSelectedAssetId}
						onAssetContextMenu={(asset) => void showAssetContextMenu(asset)}
						onRenameAsset={renameAsset}
						onCancelRename={() => setRenamingAssetId(null)}
					/>

					<div
						className="resize-handle"
						role="separator"
						aria-label="Resize asset library"
						aria-orientation="vertical"
						onPointerDown={(event) => beginResize("library", event)}
						onDoubleClick={resetLibraryWidth}
					/>

					<main className="workbench">
						{workbenchView === "table" ? (
							<TableView
								assets={library.assets}
								properties={properties}
								propertyValues={propertyValues}
								selectedAssetId={selectedAssetId}
								canEditProperties={library.rootPath !== null}
								onCreateProperty={createProperty}
								onSelectAsset={(assetId) => {
									setSelectedAssetId(assetId);
									setSidePanel("details");
								}}
							/>
						) : workbenchView === "graph" ? (
							<GraphView
								assets={library.assets}
								edges={graphEdges}
								selectedAssetId={selectedAssetId}
								relationTypes={relationTypes}
								onSelectAsset={(assetId) => {
									setSelectedAssetId(assetId);
									setSidePanel("details");
								}}
								onCreateRelation={createRelation}
								onRemoveRelation={removeRelation}
							/>
						) : selectedAsset ? (
							<AssetPreview key={selectedAsset.assetId} asset={selectedAsset} />
						) : (
							<div className="welcome">
								<div className="welcome-mark">L</div>
								<h1>{library.rootPath ? "Choose an asset" : "Open your creative workspace"}</h1>
								<p>
									{library.rootPath
										? "Select a file from the library to inspect it."
										: "Your files stay local. Loom indexes and works with them in place."}
								</p>
								{!library.rootPath && (
									<button className="primary-button" type="button" onClick={() => void openLibrary()} disabled={opening}>
										{opening ? "Opening…" : "Open Folder"}
									</button>
								)}
							</div>
						)}
					</main>

					<div
						className="resize-handle"
						role="separator"
						aria-label="Resize agent panel"
						aria-orientation="vertical"
						onPointerDown={(event) => beginResize("side", event)}
						onDoubleClick={resetSideWidth}
					/>

					<SidePanel
						libraryRoot={library.rootPath}
						activeTab={sidePanel}
						asset={selectedAsset}
						properties={properties}
						propertyValues={propertyValues}
						onChangeTab={setSidePanel}
						onCreateProperty={createProperty}
						onUpdateProperty={updateProperty}
						onRemoveProperty={removeProperty}
						onSetPropertyValue={setPropertyValue}
						onRemovePropertyValue={removePropertyValue}
						enrichment={enrichment}
						textEmbed={textEmbed}
						embedding={embedding}
						onEmbed={() => void embedSelected()}
						relations={relations}
						assets={library.assets}
						relationTypes={relationTypes}
						analyzing={analyzing}
						onAnalyze={() => void analyzeSelected()}
						onSelectAsset={(assetId) => {
							setSelectedAssetId(assetId);
							setSidePanel("details");
						}}
						onCreateRelation={(toAssetId, type) => {
							if (!selectedAsset) return Promise.resolve();
							return createRelation(selectedAsset.assetId, toAssetId, type);
						}}
						onRemoveRelation={removeRelation}
					/>
				</div>
				{settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
			</div>
		</CopilotKitProvider>
	);
}
