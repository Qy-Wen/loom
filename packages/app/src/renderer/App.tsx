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
	ImageVlmStatus,
	VideoVlmStatus,
	AudioWriteupStatus,
} from "@loom/core";
import type { AgentEndpoint } from "../shared/ipc.ts";
import type { AssetRefAttachment } from "@loom/agent";
import { sortAssets } from "./assets/asset-utils.ts";
import { canDropLibraryItem, type LibraryDrag } from "./assets/asset-drag.ts";
import { useResizableLayout } from "./layout/use-resizable-layout.ts";
import { ancestorFolders, folderSet, parentFolder } from "./library/file-tree.tsx";
import { LibrarySidebar } from "./library/library-sidebar.tsx";
import { CopyableError } from "./panel/copyable-error.tsx";
import { runActivityRenderers } from "./panel/run-activity.tsx";
import { SidePanel, type SidePanelTab } from "./panel/side-panel.tsx";
import { SettingsPage } from "./settings/settings-page.tsx";
import { AssetPreview } from "./workbench/asset-preview.tsx";
import { GraphView } from "./workbench/graph-view.tsx";
import { TableView } from "./workbench/table-view.tsx";

const EMPTY_LIBRARY: LibrarySnapshot = { rootPath: null, folders: [], assets: [] };
const EMPTY_RELATIONS: AssetRelationsResult = { generatedFrom: [], generated: [], links: [] };
type WorkbenchView = "library" | "table" | "graph";
type LibraryClipboard =
	| { kind: "assets"; assetIds: string[]; mode: "copy" | "cut" }
	| { kind: "folder"; relativePath: string; mode: "copy" | "cut" };

function sortProperties(properties: PropertyDefinition[]): PropertyDefinition[] {
	return [...properties].sort((a, b) => a.name.localeCompare(b.name));
}

/** Apply one main-process watcher event without refetching the whole library. */
function applyLibraryChange(current: LibrarySnapshot, change: LibraryChange): LibrarySnapshot {
	if (change.type === "reset") return change.snapshot;
	if (change.type === "error" || change.type === "enrichment" || change.type === "text_embed" || change.type === "image_vlm" || change.type === "video_vlm" || change.type === "audio_writeup") return current;
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
	const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
	const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
	const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
	const [libraryClipboard, setLibraryClipboard] = useState<LibraryClipboard | null>(null);
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
	const [sidePanel, setSidePanel] = useState<SidePanelTab>("agent");
	const [composerAttach, setComposerAttach] = useState<AssetRefAttachment | null>(null);
	const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("library");
	const [properties, setProperties] = useState<PropertyDefinition[]>([]);
	const [propertyValues, setPropertyValues] = useState<AssetPropertyValue[]>([]);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [enrichment, setEnrichment] = useState<AssetEnrichment | undefined>();
	const [textEmbed, setTextEmbed] = useState<TextEmbedStatus | undefined>();
	const [imageVlm, setImageVlm] = useState<ImageVlmStatus | undefined>();
	const [videoVlm, setVideoVlm] = useState<VideoVlmStatus | undefined>();
	const [audioWriteup, setAudioWriteup] = useState<AudioWriteupStatus | undefined>();
	const [relations, setRelations] = useState<AssetRelationsResult>(EMPTY_RELATIONS);
	const [graphEdges, setGraphEdges] = useState<AssetRelation[]>([]);
	const [analyzing, setAnalyzing] = useState(false);
	const [embedding, setEmbedding] = useState(false);
	const [describing, setDescribing] = useState(false);
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
			if (change.type === "folder_remove") {
				const prefix = `${change.relativePath}/`;
				setSelectedFolder((current) => {
					if (!current) return current;
					return current === change.relativePath || current.startsWith(prefix) ? null : current;
				});
				setRenamingFolder((current) => {
					if (!current) return current;
					return current === change.relativePath || current.startsWith(prefix) ? null : current;
				});
			}
			if (change.type === "enrichment" && change.assetId === selectedAssetIdRef.current) {
				void window.loom.getAssetEnrichment(change.assetId).then(setEnrichment).catch(() => undefined);
			}
			if (change.type === "text_embed" && change.assetId === selectedAssetIdRef.current) {
				void window.loom.getTextEmbedStatus(change.assetId).then(setTextEmbed).catch(() => undefined);
			}
			if (change.type === "image_vlm" && change.assetId === selectedAssetIdRef.current) {
				void window.loom.getImageVlmStatus(change.assetId).then(setImageVlm).catch(() => undefined);
				void window.loom.getTextEmbedStatus(change.assetId).then(setTextEmbed).catch(() => undefined);
			}
			if (change.type === "video_vlm" && change.assetId === selectedAssetIdRef.current) {
				void window.loom.getVideoVlmStatus(change.assetId).then(setVideoVlm).catch(() => undefined);
				void window.loom.getTextEmbedStatus(change.assetId).then(setTextEmbed).catch(() => undefined);
			}
			if (change.type === "audio_writeup" && change.assetId === selectedAssetIdRef.current) {
				void window.loom.getAudioWriteupStatus(change.assetId).then(setAudioWriteup).catch(() => undefined);
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
			setImageVlm(undefined);
			setVideoVlm(undefined);
			setAudioWriteup(undefined);
			setRelations(EMPTY_RELATIONS);
			return;
		}
		void window.loom.getAssetEnrichment(selectedAssetId).then(setEnrichment).catch(() => {
			setEnrichment(undefined);
		});
		void window.loom.getTextEmbedStatus(selectedAssetId).then(setTextEmbed).catch(() => {
			setTextEmbed(undefined);
		});
		void window.loom.getImageVlmStatus(selectedAssetId).then(setImageVlm).catch(() => {
			setImageVlm(undefined);
		});
		void window.loom.getVideoVlmStatus(selectedAssetId).then(setVideoVlm).catch(() => {
			setVideoVlm(undefined);
		});
		void window.loom.getAudioWriteupStatus(selectedAssetId).then(setAudioWriteup).catch(() => {
			setAudioWriteup(undefined);
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

	function selectAsset(assetId: string): void {
		setSelectedAssetId(assetId);
		setSelectedFolder(null);
	}

	function selectFolder(relativePath: string): void {
		setSelectedFolder(relativePath);
		setSelectedAssetId(null);
	}

	function cancelRename(): void {
		setRenamingAssetId(null);
		setRenamingFolder(null);
	}

	function pasteDestination(): string {
		if (selectedFolder) return selectedFolder;
		if (selectedAsset) return parentFolder(selectedAsset.relativePath);
		return "";
	}

	function copySelection(): void {
		if (selectedFolder) {
			setLibraryClipboard({ kind: "folder", relativePath: selectedFolder, mode: "copy" });
			return;
		}
		if (selectedAssetId) setLibraryClipboard({ kind: "assets", assetIds: [selectedAssetId], mode: "copy" });
	}

	function cutSelection(): void {
		if (selectedFolder) {
			setLibraryClipboard({ kind: "folder", relativePath: selectedFolder, mode: "cut" });
			return;
		}
		if (selectedAssetId) setLibraryClipboard({ kind: "assets", assetIds: [selectedAssetId], mode: "cut" });
	}

	function revealCreatedFolder(relativePath: string): void {
		setSelectedFolder(relativePath);
		setSelectedAssetId(null);
		setRenamingFolder(relativePath);
		const parent = parentFolder(relativePath);
		setCollapsedFolders((current) => {
			const next = new Set(current);
			next.delete(relativePath);
			if (parent) next.delete(parent);
			return next;
		});
	}

	async function createFolderIn(parentRelativePath: string): Promise<void> {
		if (!library.rootPath) return;
		setError(null);
		try {
			revealCreatedFolder(await window.loom.createFolder(parentRelativePath));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function pasteInto(destFolder: string): Promise<void> {
		if (!libraryClipboard) return;
		setError(null);
		try {
			if (libraryClipboard.kind === "assets") {
				const run = libraryClipboard.mode === "cut" ? window.loom.moveAssetsInto : window.loom.copyAssetsInto;
				const next = await run(libraryClipboard.assetIds, destFolder);
				if (next[0]) selectAsset(next[0].assetId);
			} else {
				const run = libraryClipboard.mode === "cut" ? window.loom.moveFolderInto : window.loom.copyFolderInto;
				const created = await run(libraryClipboard.relativePath, destFolder);
				setSelectedFolder(created);
				setSelectedAssetId(null);
			}
			if (libraryClipboard.mode === "cut") setLibraryClipboard(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function dropLibraryItem(destFolder: string, item: LibraryDrag): Promise<void> {
		if (!canDropLibraryItem(destFolder, item)) return;
		setError(null);
		try {
			if (item.kind === "asset") {
				const moved = await window.loom.moveAssetsInto([item.assetId], destFolder);
				if (moved[0]) selectAsset(moved[0].assetId);
			} else {
				const moved = await window.loom.moveFolderInto(item.relativePath, destFolder);
				setSelectedFolder(moved);
				setSelectedAssetId(null);
				setCollapsedFolders((current) => {
					const next = new Set(current);
					next.delete(moved);
					const parent = parentFolder(moved);
					if (parent) next.delete(parent);
					return next;
				});
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function showAssetContextMenu(asset: Asset): Promise<void> {
		selectAsset(asset.assetId);
		setError(null);
		try {
			const action = await window.loom.showAssetContextMenu(asset.assetId, libraryClipboard !== null);
			if (action === "add_to_chat") {
				if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
				setSidePanel("agent");
				setComposerAttach({
					type: "asset_ref",
					assetId: asset.assetId,
					path: asset.relativePath,
					assetType: asset.type,
				});
			} else if (action === "rename") {
				setRenamingAssetId(asset.assetId);
			} else if (action === "duplicate") {
				const duplicate = await window.loom.duplicateAsset(asset.assetId);
				selectAsset(duplicate.assetId);
			} else if (action === "copy") {
				setLibraryClipboard({ kind: "assets", assetIds: [asset.assetId], mode: "copy" });
			} else if (action === "cut") {
				setLibraryClipboard({ kind: "assets", assetIds: [asset.assetId], mode: "cut" });
			} else if (action === "paste") {
				await pasteInto(parentFolder(asset.relativePath));
			} else if (action === "new_folder") {
				await createFolderIn(parentFolder(asset.relativePath));
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

	async function showFolderContextMenu(relativePath: string): Promise<void> {
		selectFolder(relativePath);
		setError(null);
		try {
			const action = await window.loom.showFolderContextMenu(relativePath, libraryClipboard !== null);
			if (action === "rename") {
				setRenamingFolder(relativePath);
			} else if (action === "copy") {
				setLibraryClipboard({ kind: "folder", relativePath, mode: "copy" });
			} else if (action === "cut") {
				setLibraryClipboard({ kind: "folder", relativePath, mode: "cut" });
			} else if (action === "paste") {
				await pasteInto(relativePath);
			} else if (action === "new_folder") {
				await createFolderIn(relativePath);
			} else if (action === "copy_path") {
				await window.loom.copyFolderPath(relativePath);
			} else if (action === "reveal") {
				await window.loom.revealFolder(relativePath);
			} else if (action === "trash") {
				const removed = await window.loom.trashFolder(relativePath);
				if (removed) setSelectedFolder(null);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function createMarkdownIn(parentRelativePath: string): Promise<void> {
		if (!library.rootPath) return;
		setError(null);
		try {
			const created = await window.loom.createMarkdownFile(parentRelativePath);
			selectAsset(created.assetId);
			setRenamingAssetId(created.assetId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function showLibraryContextMenu(): Promise<void> {
		if (!library.rootPath) return;
		setError(null);
		try {
			const action = await window.loom.showLibraryContextMenu(libraryClipboard !== null);
			if (action === "new_folder") await createFolderIn("");
			else if (action === "new_md_file") await createMarkdownIn("");
			else if (action === "paste") await pasteInto("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	function onLibraryKeyDown(event: React.KeyboardEvent): void {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		if (!library.rootPath) return;
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.key.toLowerCase() === "c") {
			event.preventDefault();
			copySelection();
		} else if (mod && event.key.toLowerCase() === "x") {
			event.preventDefault();
			cutSelection();
		} else if (mod && event.key.toLowerCase() === "v") {
			event.preventDefault();
			void pasteInto(pasteDestination());
		} else if (event.key === "F2") {
			event.preventDefault();
			if (selectedFolder) setRenamingFolder(selectedFolder);
			else if (selectedAssetId) setRenamingAssetId(selectedAssetId);
		} else if (mod && event.shiftKey && event.key.toLowerCase() === "n") {
			event.preventDefault();
			void createFolderIn(pasteDestination());
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

	async function renameFolder(relativePath: string, name: string): Promise<void> {
		setError(null);
		try {
			setSelectedFolder(await window.loom.renameFolder(relativePath, name));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRenamingFolder(null);
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

	async function describeSelected(): Promise<void> {
		if (!selectedAssetId) return;
		setDescribing(true);
		setError(null);
		try {
			if (selectedAsset?.type === "video") {
				setVideoVlm(await window.loom.describeVideo(selectedAssetId));
			} else if (selectedAsset?.type === "audio") {
				setAudioWriteup(await window.loom.describeAudio(selectedAssetId));
			} else {
				setImageVlm(await window.loom.describeImage(selectedAssetId));
			}
			setTextEmbed(await window.loom.getTextEmbedStatus(selectedAssetId));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setDescribing(false);
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
				setSelectedFolder(null);
				setRenamingAssetId(null);
				setRenamingFolder(null);
				setLibraryClipboard(null);
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
		<CopilotKitProvider runtimeUrl={endpoint.runtimeUrl} agentId={endpoint.agentId} renderActivityMessages={runActivityRenderers}>
			<div className="app">
				<header className="topbar">
					<span className="brand">Loom</span>
					<nav className="view-switcher" aria-label="Workspace views">
						<button
							className={workbenchView === "library" ? "active" : ""}
							type="button"
							onClick={() => setWorkbenchView("library")}
						>Library</button>
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
					<div className="topbar-actions">
						{import.meta.env.DEV ? (
							<button className="topbar-settings" type="button" onClick={() => void window.loom.openDevTrace?.()}>
								Traces
							</button>
						) : null}
						<button className="topbar-settings" type="button" onClick={() => setSettingsOpen(true)}>
							Settings
						</button>
					</div>
				</header>

				{error && (
					<div className="error-banner">
						<CopyableError text={error} />
					</div>
				)}

				<div className="shell" ref={shellRef} style={shellStyle}>
					<LibrarySidebar
						library={library}
						opening={opening}
						selectedAssetId={selectedAssetId}
						selectedFolder={selectedFolder}
						renamingAssetId={renamingAssetId}
						renamingFolder={renamingFolder}
						collapsedFolders={collapsedFolders}
						cutAssetIds={libraryClipboard?.kind === "assets" && libraryClipboard.mode === "cut" ? libraryClipboard.assetIds : []}
						cutFolder={libraryClipboard?.kind === "folder" && libraryClipboard.mode === "cut" ? libraryClipboard.relativePath : null}
						onOpenLibrary={() => void openLibrary()}
						onToggleFolder={toggleFolder}
						onSelectAsset={selectAsset}
						onSelectFolder={selectFolder}
						onAssetContextMenu={(asset) => void showAssetContextMenu(asset)}
						onFolderContextMenu={(relativePath) => void showFolderContextMenu(relativePath)}
						onLibraryContextMenu={() => void showLibraryContextMenu()}
						onRenameAsset={renameAsset}
						onRenameFolder={renameFolder}
						onCancelRename={cancelRename}
						onDropIntoFolder={(dest, item) => void dropLibraryItem(dest, item)}
						onKeyDown={onLibraryKeyDown}
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
									selectAsset(assetId);
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
									selectAsset(assetId);
									setSidePanel("details");
								}}
								onCreateRelation={createRelation}
								onRemoveRelation={removeRelation}
							/>
						) : selectedAsset ? (
							<AssetPreview key={selectedAsset.assetId} asset={selectedAsset} assets={library.assets} />
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
						imageVlm={imageVlm}
						videoVlm={videoVlm}
						audioWriteup={audioWriteup}
						describing={describing}
						onDescribe={() => void describeSelected()}
						relations={relations}
						assets={library.assets}
						relationTypes={relationTypes}
						analyzing={analyzing}
						onAnalyze={() => void analyzeSelected()}
						onSelectAsset={(assetId) => {
							selectAsset(assetId);
							setSidePanel("details");
						}}
						onOpenAsset={selectAsset}
						composerAttach={composerAttach}
						onComposerAttachApplied={() => setComposerAttach(null)}
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
