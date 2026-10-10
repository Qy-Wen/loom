import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import { useLocale } from "./locale.tsx";
import type { AssetRefAttachment } from "@loom/agent";
import { isGradeableImage } from "@loom/core/grade";
import { sortAssets } from "./assets/asset-utils.ts";
import { canDropLibraryItem, type LibraryDrag } from "./assets/asset-drag.ts";
import { usePanelLayout, type PanelId } from "./layout/use-panel-layout.ts";
import { useResizableLayout } from "./layout/use-resizable-layout.ts";
import { PanelTabs, WorkPanel } from "./layout/work-panel.tsx";
import { ancestorFolders, folderSet, parentFolder } from "./library/file-tree.tsx";
import { LibrarySidebar } from "./library/library-sidebar.tsx";
import { ErrorToast } from "./panel/error-toast.tsx";
import { runActivityRenderers } from "./panel/run-activity.tsx";
import { AgentPanel, DetailsPanel } from "./panel/side-panel.tsx";
import { SettingsPage } from "./settings/settings-page.tsx";
import { AssetPreview } from "./workbench/asset-preview.tsx";
import { GraphView } from "./workbench/graph-view.tsx";
import { TableView } from "./workbench/table-view.tsx";

const EMPTY_LIBRARY: LibrarySnapshot = { rootPath: null, folders: [], assets: [], favoriteAssetIds: [], tags: [], assetTags: [] };
const EMPTY_RELATIONS: AssetRelationsResult = { links: [] };
type WorkbenchView = "library" | "table" | "graph";

function meetsWindowCorner(
	frame: { x: number; y: number; width: number; height: number },
	shell: HTMLElement | null,
): boolean {
	if (!shell) return false;
	return frame.x + frame.width >= shell.clientWidth - 2 && frame.y + frame.height >= shell.clientHeight - 2;
}

type Layout = ReturnType<typeof usePanelLayout>;

function groupClass(panels: Layout): string {
	const mode = panels.place(panels.members[0] ?? "agent").mode;
	const snapping = panels.groupDrag && (panels.dragDock || panels.lowerFrame || panels.spliceFrame) ? " snapping" : "";
	const placed = panels.groupDrag
		? ""
		: mode === "bottom" ? " bottom-band"
			: mode === "float" ? " floating"
				: mode === "beside" ? " beside-band"
					: mode === "above" ? " above-band"
						: " dock-band";
	return `side-stack joined${placed}${panels.groupDrag ? " group-drag" : ""}${snapping}`;
}

function stackClass(panels: Layout, loose: readonly PanelId[], share: boolean): string {
	const modes = new Set(loose.map((id) => panels.place(id).mode));
	if (share || modes.size > 1) return "side-stack spread";
	if (modes.has("dock")) return "side-stack";
	if (modes.has("beside")) return "side-stack beside-band";
	if (modes.has("above")) return "side-stack above-band";
	if (modes.has("bottom") && panels.bothBottom && !panels.joined) return "side-stack bottom-band";
	if (modes.has("bottom")) return "side-stack spread";
	return "side-stack floating";
}
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
	if (change.type === "favorites") return { ...current, favoriteAssetIds: change.assetIds };
	if (change.type === "tags") return { ...current, tags: change.tags, assetTags: change.assetTags };
	if (change.type === "remove") {
		const assetTags = current.assetTags.filter((row) => row.assetId !== change.assetId);
		const used = new Set(assetTags.map((row) => row.tagId));
		return {
			...current,
			assets: current.assets.filter((asset) => asset.assetId !== change.assetId),
			favoriteAssetIds: current.favoriteAssetIds.filter((id) => id !== change.assetId),
			assetTags,
			tags: current.tags.filter((tag) => used.has(tag.tagId)),
		};
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
	const { t } = useLocale();
	const [endpoint, setEndpoint] = useState<AgentEndpoint | null>(null);
	const [library, setLibrary] = useState<LibrarySnapshot>(EMPTY_LIBRARY);
	const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
	const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
	const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
	const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
	const [libraryClipboard, setLibraryClipboard] = useState<LibraryClipboard | null>(null);
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
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
		resetBesideWidth,
	} = useResizableLayout();
	const selectedAsset = useMemo(
		() => library.assets.find((asset) => asset.assetId === selectedAssetId) ?? null,
		[library.assets, selectedAssetId],
	);
	const gradeVisible = workbenchView === "library"
		&& selectedAsset?.type === "image"
		&& isGradeableImage(selectedAsset.filename);
	const panels = usePanelLayout(shellRef, gradeVisible);
	const [gradeHost, setGradeHost] = useState<HTMLDivElement | null>(null);

	useEffect(() => {
		if (gradeVisible) panels.focus("grade");
	}, [gradeVisible, selectedAsset?.assetId]);

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
		() => [...new Set(graphEdges.map((edge) => edge.type))].sort(),
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
			if (action === "favorite" || action === "unfavorite") {
				await window.loom.setFavorite(asset.assetId, action === "favorite");
			} else if (action === "add_to_chat") {
				if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
				panels.focus("agent");
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

	async function addTag(assetId: string, name: string): Promise<void> {
		setError(null);
		try {
			await window.loom.addAssetTag(assetId, name);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function removeTag(assetId: string, tagId: string): Promise<void> {
		setError(null);
		try {
			await window.loom.removeAssetTag(assetId, tagId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
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
		return <div className="loading">{error ?? t.app.connecting}</div>;
	}

	const member = (id: PanelId) => panels.members.includes(id);
	const loose = (["agent", "details", "grade"] as const).filter((id) => !member(id) && (id !== "grade" || gradeVisible));
	const groupMode = panels.joined ? panels.place(panels.members[0]).mode : null;
	const shareBottom = loose.filter((id) => panels.place(id).mode === "bottom").length + (groupMode === "bottom" ? 1 : 0) >= 2
		&& !(panels.bothBottom && !panels.joined);
	const shareBeside = loose.filter((id) => panels.place(id).mode === "beside").length + (groupMode === "beside" ? 1 : 0) >= 2
		&& !(panels.bothBeside && !panels.joined);
	const shareAbove = loose.filter((id) => panels.place(id).mode === "above").length + (groupMode === "above" ? 1 : 0) >= 2
		&& !(panels.bothAbove && !panels.joined);
	const inCluster = (id: PanelId) => shareBottom && !member(id) && panels.place(id).mode === "bottom";
	const inBeside = (id: PanelId) => shareBeside && !member(id) && panels.place(id).mode === "beside";
	const inAbove = (id: PanelId) => shareAbove && !member(id) && panels.place(id).mode === "above";
	const parked = (id: PanelId) => inCluster(id) || inBeside(id) || inAbove(id);
	const groupInCluster = shareBottom && groupMode === "bottom";
	const groupInBeside = shareBeside && groupMode === "beside";
	const groupInAbove = shareAbove && groupMode === "above";
	const joinedGroup = !panels.joined ? null : (
		<div className={groupClass(panels)} style={panels.groupStyle()}>
			<PanelTabs layout={panels} />
			{member("agent") && <WorkPanel id="agent" title={t.app.agent} layout={panels}>
				<AgentPanel
					libraryRoot={library.rootPath}
					assets={library.assets}
					onOpenAsset={selectAsset}
					composerAttach={composerAttach}
					onComposerAttachApplied={() => setComposerAttach(null)}
				/>
			</WorkPanel>}
			{member("details") && <WorkPanel id="details" title={t.app.details} layout={panels}>
				<DetailsPanel
					asset={selectedAsset}
					properties={properties}
					propertyValues={propertyValues}
					tags={library.tags}
					assetTags={library.assetTags}
					onAddTag={addTag}
					onRemoveTag={removeTag}
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
					onSelectAsset={(assetId) => {
						selectAsset(assetId);
						panels.focus("details");
					}}
					onCreateRelation={(fromAssetId, toAssetId, type) => createRelation(fromAssetId, toAssetId, type)}
					onRemoveRelation={removeRelation}
				/>
			</WorkPanel>}
			{member("grade") && gradeVisible && (
				<WorkPanel id="grade" title={t.grade.panel} layout={panels}>
					<div className="grade-panel-host" ref={setGradeHost} />
				</WorkPanel>
			)}
			{groupMode === "float" && !panels.groupDrag && (
				<>
									<div className="work-panel-edge right" onPointerDown={(event) => panels.beginResize(panels.members[0] ?? "agent", "right", event)} />
									<div className="work-panel-edge bottom" onPointerDown={(event) => panels.beginResize(panels.members[0] ?? "agent", "bottom", event)} />
									<div className="work-panel-edge corner" onPointerDown={(event) => panels.beginResize(panels.members[0] ?? "agent", "corner", event)} />
				</>
			)}
		</div>
	);

	return (
		<CopilotKitProvider runtimeUrl={endpoint.runtimeUrl} agentId={endpoint.agentId} renderActivityMessages={runActivityRenderers}>
			<div className="app">
				{error && <ErrorToast text={error} onDismiss={() => setError(null)} />}

				<div
					className={`shell${panels.anyDocked ? "" : " side-hidden"}${panels.anyBottom ? " has-bottom" : ""}${panels.anyBeside ? " has-beside" : ""}${panels.anyAbove ? " has-above" : ""}${panels.dragDock ? " dock-target" : ""}${panels.lowerFrame ? " lower-target" : ""}${panels.joinFrame ? " join-target" : ""}${panels.spliceFrame ? " splice-target" : ""}${panels.joinFrame && meetsWindowCorner(panels.joinFrame, shellRef.current) ? " window-corner" : ""}`}
					ref={shellRef}
					style={{
						...shellStyle,
						...({ "--window-corner": navigator.userAgent.includes("Windows") ? "8px" : "16px" } as CSSProperties),
						...(panels.anyBottom ? { "--bottom-height": `${panels.bottomHeight}px` } : {}),
						...(panels.anyAbove ? { "--above-height": `${panels.aboveHeight}px` } : {}),
						...(panels.spliceFrame ? {
							"--splice-x": `${panels.spliceFrame.x}px`,
							"--splice-y": `${panels.spliceFrame.y}px`,
							"--splice-w": `${panels.spliceFrame.width}px`,
							"--splice-h": `${panels.spliceFrame.height}px`,
						} : {}),
						...(panels.lowerFrame ? {
							"--lower-x": `${panels.lowerFrame.x}px`,
							"--lower-y": `${panels.lowerFrame.y}px`,
							"--lower-w": `${panels.lowerFrame.width}px`,
							"--lower-h": `${panels.lowerFrame.height}px`,
						} : {}),
						...(panels.joinFrame ? {
							"--join-x": `${panels.joinFrame.x}px`,
							"--join-y": `${panels.joinFrame.y}px`,
							"--join-w": `${panels.joinFrame.width}px`,
							"--join-h": `${panels.joinFrame.height}px`,
						} : {}),
					}}
				>
					<LibrarySidebar
						library={library}
						opening={opening}
						workbenchView={workbenchView}
						onWorkbenchView={setWorkbenchView}
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
						onOpenSettings={() => setSettingsOpen(true)}
						onOpenTraces={import.meta.env.DEV ? () => void window.loom.openDevTrace?.() : undefined}
					/>

					<div
						className="resize-handle library-resize"
						role="separator"
						aria-label={t.app.resizeLibrary}
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
								onUpdateProperty={updateProperty}
								onRemoveProperty={removeProperty}
								onSetPropertyValue={setPropertyValue}
								onRemovePropertyValue={removePropertyValue}
								onSelectAsset={(assetId) => {
									selectAsset(assetId);
									panels.focus("details");
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
									panels.focus("details");
								}}
								onCreateRelation={createRelation}
								onRemoveRelation={removeRelation}
							/>
						) : selectedAsset ? (
							<AssetPreview key={selectedAsset.assetId} asset={selectedAsset} assets={library.assets} onGraded={selectAsset} gradeHost={gradeHost} />
						) : (
							<div className="welcome">
								<div className="welcome-mark">L</div>
								<h1>{library.rootPath ? t.app.chooseAsset : t.app.openWorkspace}</h1>
								<p>
									{library.rootPath
										? t.app.selectFile
										: t.app.filesStayLocal}
								</p>
								{!library.rootPath && (
									<button className="primary-button" type="button" onClick={() => void openLibrary()} disabled={opening}>
										{opening ? t.app.opening : t.app.openFolder}
									</button>
								)}
							</div>
						)}
					</main>

					{panels.anyBeside && (
						<div
							className="resize-handle beside-resize"
							role="separator"
							aria-label={t.app.resizeAgent}
							aria-orientation="vertical"
							onPointerDown={(event) => beginResize("beside", event)}
							onDoubleClick={resetBesideWidth}
						/>
					)}

					{panels.anyDocked && (
						<div
							className="resize-handle side-resize"
							role="separator"
							aria-label={t.app.resizeAgent}
							aria-orientation="vertical"
							onPointerDown={(event) => beginResize("side", event)}
							onDoubleClick={resetSideWidth}
						/>
					)}

					{panels.anyAbove && (
						<div
							className="resize-handle row above-resize"
							role="separator"
							aria-label={t.app.resizeLower}
							aria-orientation="horizontal"
							onPointerDown={(event) => panels.beginAboveResize(event)}
						/>
					)}

					{panels.anyBottom && (
						<div
							className="resize-handle row bottom-resize"
							role="separator"
							aria-label={t.app.resizeLower}
							aria-orientation="horizontal"
							onPointerDown={(event) => panels.beginBottomResize(event)}
						/>
					)}

					{loose.length > 0 && <div className={stackClass(panels, loose, shareBottom || shareBeside || shareAbove)}>
						{!member("agent") && !parked("agent") && <WorkPanel id="agent" title={t.app.agent} layout={panels}>
							<AgentPanel
								libraryRoot={library.rootPath}
								assets={library.assets}
								onOpenAsset={selectAsset}
								composerAttach={composerAttach}
								onComposerAttachApplied={() => setComposerAttach(null)}
							/>
						</WorkPanel>}
						{(panels.bothDocked || panels.bothBottom || panels.bothBeside || panels.bothAbove) && !panels.joined && (
							<div
								className="resize-handle row"
								role="separator"
								aria-label={t.app.resizeSplit}
								aria-orientation="horizontal"
								onPointerDown={(event) => panels.beginDockSplit(event)}
							/>
						)}
						{!member("details") && !parked("details") && <WorkPanel id="details" title={t.app.details} layout={panels}>
							<DetailsPanel
								asset={selectedAsset}
								properties={properties}
								propertyValues={propertyValues}
								tags={library.tags}
								assetTags={library.assetTags}
								onAddTag={addTag}
								onRemoveTag={removeTag}
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
								onSelectAsset={(assetId) => {
									selectAsset(assetId);
									panels.focus("details");
								}}
								onCreateRelation={(fromAssetId, toAssetId, type) => createRelation(fromAssetId, toAssetId, type)}
								onRemoveRelation={removeRelation}
							/>
						</WorkPanel>}
						{shareBottom && (
							<div className="bottom-cluster">
								{inCluster("agent") && <WorkPanel id="agent" title={t.app.agent} layout={panels}>
									<AgentPanel
										libraryRoot={library.rootPath}
										assets={library.assets}
										onOpenAsset={selectAsset}
										composerAttach={composerAttach}
										onComposerAttachApplied={() => setComposerAttach(null)}
									/>
								</WorkPanel>}
								{inCluster("details") && <WorkPanel id="details" title={t.app.details} layout={panels}>
									<DetailsPanel
										asset={selectedAsset}
										properties={properties}
										propertyValues={propertyValues}
										tags={library.tags}
										assetTags={library.assetTags}
										onAddTag={addTag}
										onRemoveTag={removeTag}
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
										onSelectAsset={(assetId) => {
											selectAsset(assetId);
											panels.focus("details");
										}}
										onCreateRelation={(fromAssetId, toAssetId, type) => createRelation(fromAssetId, toAssetId, type)}
										onRemoveRelation={removeRelation}
									/>
								</WorkPanel>}
								{inCluster("grade") && (
									<WorkPanel id="grade" title={t.grade.panel} layout={panels}>
										<div className="grade-panel-host" ref={setGradeHost} />
									</WorkPanel>
								)}
								{groupInCluster && joinedGroup}
							</div>
						)}
						{(shareBeside || shareAbove) && (
							<div className={shareBeside ? "beside-cluster" : "above-cluster"}>
								{(shareBeside ? inBeside("agent") : inAbove("agent")) && <WorkPanel id="agent" title={t.app.agent} layout={panels}>
									<AgentPanel
										libraryRoot={library.rootPath}
										assets={library.assets}
										onOpenAsset={selectAsset}
										composerAttach={composerAttach}
										onComposerAttachApplied={() => setComposerAttach(null)}
									/>
								</WorkPanel>}
								{(shareBeside ? inBeside("details") : inAbove("details")) && <WorkPanel id="details" title={t.app.details} layout={panels}>
									<DetailsPanel
										asset={selectedAsset}
										properties={properties}
										propertyValues={propertyValues}
										tags={library.tags}
										assetTags={library.assetTags}
										onAddTag={addTag}
										onRemoveTag={removeTag}
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
										onSelectAsset={(assetId) => {
											selectAsset(assetId);
											panels.focus("details");
										}}
										onCreateRelation={(fromAssetId, toAssetId, type) => createRelation(fromAssetId, toAssetId, type)}
										onRemoveRelation={removeRelation}
									/>
								</WorkPanel>}
								{gradeVisible && (shareBeside ? inBeside("grade") : inAbove("grade")) && (
									<WorkPanel id="grade" title={t.grade.panel} layout={panels}>
										<div className="grade-panel-host" ref={setGradeHost} />
									</WorkPanel>
								)}
								{(groupInBeside || groupInAbove) && joinedGroup}
							</div>
						)}
						{gradeVisible && !member("grade") && !parked("grade") && (
							<WorkPanel id="grade" title={t.grade.panel} layout={panels}>
								<div className="grade-panel-host" ref={setGradeHost} />
							</WorkPanel>
						)}
					</div>}
					{!groupInCluster && !groupInBeside && !groupInAbove && joinedGroup}
				</div>
				{settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
			</div>
		</CopilotKitProvider>
	);
}
