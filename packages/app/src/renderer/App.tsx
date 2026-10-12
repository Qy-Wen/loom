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
import { isGradeableImage, isGradeableVideo } from "@loom/core/grade";
import { sortAssets } from "./assets/asset-utils.ts";
import { canDropLibraryItem, type LibraryDrag } from "./assets/asset-drag.ts";
import { usePanelLayout } from "./layout/use-panel-layout.ts";
import { useResizableLayout } from "./layout/use-resizable-layout.ts";
import { PanelWorkspace, PanelsToggle, type PanelView } from "./layout/work-panel.tsx";
import { ancestorFolders, folderSet, parentFolder } from "./library/file-tree.tsx";
import {
	assetKey,
	contextSelection,
	cursorsForKeys,
	emptyTreeSelection,
	extendSelection,
	folderKey,
	isExtendKey,
	isLibraryTrashKey,
	isTreeNavKey,
	pointerSelect,
	rootLibraryItems,
	selectVisible,
	singleSelection,
	treeMotion,
	withoutFolder,
	withoutKey,
	type PointerMode,
	type TreeCursor,
	type TreeRow,
	type TreeSelection,
} from "./library/tree-nav.ts";
import { uiPlatform } from "../shared/locale.ts";
import { LibraryOpenButton, LibrarySidebar, SettingsButton, SidebarToggle, TracesButton } from "./library/library-sidebar.tsx";
import { ErrorToast } from "./panel/error-toast.tsx";
import { runActivityRenderers } from "./panel/run-activity.tsx";
import { AgentPanel, DetailsPanel } from "./panel/side-panel.tsx";
import { SettingsPage } from "./settings/settings-page.tsx";
import { AssetPreview, PreviewActions } from "./workbench/asset-preview.tsx";
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

type LibraryClipboard = {
	mode: "copy" | "cut";
	assetIds: string[];
	folders: string[];
};

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
	const [picked, setPicked] = useState<TreeSelection>(emptyTreeSelection);
	const selectedAssetId = picked.focus?.startsWith("asset:") ? picked.focus.slice("asset:".length) : null;
	const selectedFolder = picked.focus?.startsWith("folder:") ? picked.focus.slice("folder:".length) : null;
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
	const [status, setStatus] = useState<string | null>(null);
	const statusCount = useRef(0);
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
	const [fullscreen, setFullscreen] = useState(false);
	const selectedAssetIdRef = useRef<string | null>(null);
	const {
		shellRef,
		shellStyle,
		beginResize,
		libraryCollapsed,
		toggleLibraryCollapsed,
		resetLibraryWidth,
		resetSideWidth,
		resetBesideWidth,
	} = useResizableLayout();
	useEffect(() => {
		let alive = true;
		void window.loom.isFullscreen().then((value) => {
			if (alive) setFullscreen(value);
		});
		const stop = window.loom.onFullscreenChanged(setFullscreen);
		return () => {
			alive = false;
			stop();
		};
	}, []);
	const selectedAsset = useMemo(
		() => library.assets.find((asset) => asset.assetId === selectedAssetId) ?? null,
		[library.assets, selectedAssetId],
	);
	const selectedKeys = useMemo(() => new Set(picked.keys), [picked.keys]);
	const selectionDrag = useMemo((): LibraryDrag | null => {
		const items = rootLibraryItems(cursorsForKeys(picked.keys, library.assets));
		if (items.assetIds.length + items.folders.length < 2) return null;
		return {
			kind: "batch",
			assets: items.assetIds.flatMap((assetId) => {
				const asset = library.assets.find((item) => item.assetId === assetId);
				return asset ? [{ assetId, path: asset.relativePath }] : [];
			}),
			folders: items.folders,
		};
	}, [picked.keys, library.assets]);
	const [gradingAssetId, setGradingAssetId] = useState<string | null>(null);
	const gradeable = !!selectedAsset && (
		(selectedAsset.type === "image" && isGradeableImage(selectedAsset.filename))
		|| (selectedAsset.type === "video" && isGradeableVideo(selectedAsset.filename))
	);
	const grading = gradeable && gradingAssetId === selectedAsset.assetId;
	const gradeVisible = workbenchView === "library" && grading;
	const [gradeHost, setGradeHost] = useState<HTMLDivElement | null>(null);
	// One product registry supplies identity, content, visibility and first-use policy.
	const panelViews: PanelView[] = [
		{ id: "agent", visible: true, title: t.app.agent, render: () => <AgentPanel libraryRoot={library.rootPath} assets={library.assets} onOpenAsset={selectAsset} composerAttach={composerAttach} onComposerAttachApplied={() => setComposerAttach(null)} /> },
		{ id: "details", visible: true, title: t.app.details, render: () => <DetailsPanel
			asset={selectedAsset} properties={properties} propertyValues={propertyValues}
			tags={library.tags} assetTags={library.assetTags} onAddTag={addTag} onRemoveTag={removeTag}
			enrichment={enrichment} textEmbed={textEmbed} embedding={embedding} onEmbed={() => void embedSelected()}
			imageVlm={imageVlm} videoVlm={videoVlm} audioWriteup={audioWriteup} describing={describing} onDescribe={() => void describeSelected()}
			relations={relations} assets={library.assets} relationTypes={relationTypes}
			onSelectAsset={(assetId) => { selectAsset(assetId); panels.focus("details"); }}
			onCreateRelation={createRelation} onRemoveRelation={removeRelation}
		/> },
		{ id: "grade", visible: gradeVisible, title: t.grade.panel, firstOpen: { place: { mode: "dock" }, join: ["details", "agent"] }, render: () => <div className="grade-panel-host" ref={setGradeHost} /> },
	];
	const panels = usePanelLayout(shellRef, panelViews);
	useEffect(() => {
		setGradingAssetId((current) => current === selectedAsset?.assetId ? current : null);
	}, [selectedAsset?.assetId]);

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
				setPicked((current) => withoutKey(current, assetKey(change.assetId)));
			}
			if (change.type === "reset") {
				setCollapsedFolders(folderSet(change.snapshot));
				setPicked(emptyTreeSelection);
			}
			if (change.type === "folder_remove") {
				const prefix = `${change.relativePath}/`;
				setPicked((current) => withoutFolder(current, change.relativePath));
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

	function revealFolders(relativePaths: readonly string[]): void {
		setCollapsedFolders((current) => {
			const next = new Set(current);
			for (const relativePath of relativePaths) {
				next.delete(relativePath);
				let parent = parentFolder(relativePath);
				while (parent) {
					next.delete(parent);
					parent = parentFolder(parent);
				}
			}
			return next;
		});
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
		setPicked(singleSelection(assetKey(assetId)));
	}

	function selectFolder(relativePath: string): void {
		setPicked(singleSelection(folderKey(relativePath)));
	}

	function clearLibrarySelection(): void {
		setPicked(emptyTreeSelection);
	}

	function chooseTreeKey(key: string, mode: PointerMode, rows: readonly TreeRow[]): void {
		setPicked((current) => pointerSelect(current, rows, key, mode));
	}

	function cancelRename(): void {
		setRenamingAssetId(null);
		setRenamingFolder(null);
	}

	function pasteDestination(selection: TreeSelection = picked): string {
		const focus = selection.focus;
		if (!focus) return "";
		if (focus.startsWith("folder:")) return focus.slice("folder:".length);
		const asset = library.assets.find((item) => item.assetId === focus.slice("asset:".length));
		return asset ? parentFolder(asset.relativePath) : "";
	}

	function clipboardFor(selection: TreeSelection, mode: "copy" | "cut"): LibraryClipboard | null {
		const items = rootLibraryItems(cursorsForKeys(selection.keys, library.assets));
		if (items.assetIds.length === 0 && items.folders.length === 0) return null;
		return { mode, assetIds: items.assetIds, folders: items.folders };
	}

	function copySelection(selection: TreeSelection = picked): void {
		const next = clipboardFor(selection, "copy");
		if (next) setLibraryClipboard(next);
	}

	function cutSelection(selection: TreeSelection = picked): void {
		const next = clipboardFor(selection, "cut");
		if (next) setLibraryClipboard(next);
	}

	function revealCreatedFolder(relativePath: string): void {
		selectFolder(relativePath);
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

	function beginStatus(label: string): () => void {
		statusCount.current += 1;
		const show = window.setTimeout(() => {
			if (statusCount.current > 0) setStatus(label);
		}, 400);
		return () => {
			window.clearTimeout(show);
			statusCount.current -= 1;
			if (statusCount.current === 0) setStatus(null);
		};
	}

	async function whileBusy<T>(label: string, work: () => Promise<T>): Promise<T> {
		const end = beginStatus(label);
		try {
			return await work();
		} finally {
			end();
		}
	}

	async function withTrashNotice<T>(work: () => Promise<T>): Promise<T> {
		const end: { current: (() => void) | null } = { current: null };
		const unsubscribe = window.loom.onTrashStarted(() => {
			if (!end.current) end.current = beginStatus(t.library.deleting);
		});
		try {
			return await work();
		} finally {
			unsubscribe();
			end.current?.();
		}
	}

	function showPlaced(destFolder: string, placed: { assets: { assetId: string }[]; folders: string[] }): void {
		const keys = [...placed.folders.map(folderKey), ...placed.assets.map((asset) => assetKey(asset.assetId))];
		const focus = placed.assets[0] ? assetKey(placed.assets[0].assetId) : keys[0];
		if (focus) setPicked({ keys, anchor: focus, focus });
		revealFolders(destFolder ? [destFolder, ...placed.folders] : placed.folders);
	}

	async function placeExternalPaths(absolutePaths: string[], destFolder: string, move: boolean): Promise<void> {
		if (absolutePaths.length === 0) return;
		setError(null);
		try {
			showPlaced(destFolder, await window.loom.placePathsInto(absolutePaths, destFolder, move));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function pasteInto(destFolder: string): Promise<void> {
		await whileBusy(t.library.pasting, async () => {
			if (libraryClipboard) {
				setError(null);
				try {
					const move = libraryClipboard.mode === "cut";
					const next = libraryClipboard.assetIds.length > 0
						? await (move ? window.loom.moveAssetsInto : window.loom.copyAssetsInto)(libraryClipboard.assetIds, destFolder)
						: [];
					const folders: string[] = [];
					const placeFolder = move ? window.loom.moveFolderInto : window.loom.copyFolderInto;
					for (const folder of libraryClipboard.folders) folders.push(await placeFolder(folder, destFolder));
					showPlaced(destFolder, { assets: next, folders });
					if (move) setLibraryClipboard(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
				return;
			}
			try {
				const clip = await window.loom.readFileClipboard();
				if (!clip) return;
				await placeExternalPaths(clip.paths, destFolder, clip.move);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		});
	}

	async function dropExternalFiles(destFolder: string, files: File[]): Promise<void> {
		const paths: string[] = [];
		for (const file of files) {
			try {
				const path = window.loom.pathForFile(file);
				if (path) paths.push(path);
			} catch {
				// Skip entries without a local path.
			}
		}
		if (paths.length === 0) {
			setError(t.library.importFailed);
			return;
		}
		await whileBusy(t.library.pasting, () => placeExternalPaths(paths, destFolder, false));
	}

	async function dropLibraryItem(destFolder: string, item: LibraryDrag): Promise<void> {
		if (!canDropLibraryItem(destFolder, item)) return;
		setError(null);
		try {
			if (item.kind === "batch") {
				const movedAssets = item.assets.length > 0
					? await window.loom.moveAssetsInto(item.assets.map((asset) => asset.assetId), destFolder)
					: [];
				const movedFolders: string[] = [];
				for (const folder of item.folders) movedFolders.push(await window.loom.moveFolderInto(folder, destFolder));
				const keys = [...movedFolders.map(folderKey), ...movedAssets.map((asset) => assetKey(asset.assetId))];
				const focus = movedAssets[0] ? assetKey(movedAssets[0].assetId) : keys[0];
				if (focus) setPicked({ keys, anchor: focus, focus });
				revealFolders(movedFolders);
			} else if (item.kind === "asset") {
				const moved = await window.loom.moveAssetsInto([item.assetId], destFolder);
				if (moved[0]) selectAsset(moved[0].assetId);
			} else {
				const moved = await window.loom.moveFolderInto(item.relativePath, destFolder);
				selectFolder(moved);
				revealFolders([moved]);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function showAssetContextMenu(asset: Asset): Promise<void> {
		const next = contextSelection(picked, assetKey(asset.assetId));
		setPicked(next);
		setError(null);
		try {
			const action = await window.loom.showAssetContextMenu(asset.assetId, libraryClipboard !== null, next.keys.length === 1);
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
			} else if (action === "rename" && next.keys.length === 1) {
				setRenamingAssetId(asset.assetId);
			} else if (action === "duplicate") {
				await duplicateSelection(next);
			} else if (action === "copy") {
				copySelection(next);
			} else if (action === "cut") {
				cutSelection(next);
			} else if (action === "paste") {
				await pasteInto(parentFolder(asset.relativePath));
			} else if (action === "new_folder") {
				await createFolderIn(parentFolder(asset.relativePath));
			} else if (action === "copy_path") {
				await copySelectionPaths(next);
			} else if (action === "reveal") {
				await window.loom.revealAsset(asset.assetId);
			} else if (action === "trash") {
				if (await trashSelection(next)) clearLibrarySelection();
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function showFolderContextMenu(relativePath: string): Promise<void> {
		const next = contextSelection(picked, folderKey(relativePath));
		setPicked(next);
		setError(null);
		try {
			const action = await window.loom.showFolderContextMenu(relativePath, libraryClipboard !== null, next.keys.length === 1);
			if (action === "rename" && next.keys.length === 1) {
				setRenamingFolder(relativePath);
			} else if (action === "copy") {
				copySelection(next);
			} else if (action === "cut") {
				cutSelection(next);
			} else if (action === "paste") {
				await pasteInto(relativePath);
			} else if (action === "new_folder") {
				await createFolderIn(relativePath);
			} else if (action === "copy_path") {
				await copySelectionPaths(next);
			} else if (action === "reveal") {
				await window.loom.revealFolder(relativePath);
			} else if (action === "trash") {
				if (await trashSelection(next)) clearLibrarySelection();
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

	function libraryCursor(): TreeCursor | null {
		if (selectedFolder) return { kind: "folder", relativePath: selectedFolder };
		if (selectedAsset) return { kind: "asset", assetId: selectedAsset.assetId, relativePath: selectedAsset.relativePath };
		return null;
	}

	async function duplicateSelection(selection: TreeSelection = picked): Promise<void> {
		const { assetIds } = rootLibraryItems(cursorsForKeys(selection.keys, library.assets));
		if (assetIds.length === 0) return;
		setError(null);
		try {
			const created = [];
			for (const assetId of assetIds) created.push(await window.loom.duplicateAsset(assetId));
			const keys = created.map((asset) => assetKey(asset.assetId));
			setPicked({ keys, anchor: keys[0], focus: keys[0] });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function copySelectionPaths(selection: TreeSelection = picked): Promise<void> {
		const items = rootLibraryItems(cursorsForKeys(selection.keys, library.assets));
		if (items.assetIds.length === 0 && items.folders.length === 0) return;
		setError(null);
		try {
			await window.loom.copyLibraryPaths(items.assetIds, items.folders);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function togglePreviewFavorite(asset: Asset): Promise<void> {
		setError(null);
		try {
			await window.loom.setFavorite(asset.assetId, !library.favoriteAssetIds.includes(asset.assetId));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function trashPreviewed(assetId: string): Promise<void> {
		setError(null);
		try {
			await withTrashNotice(() => window.loom.trashAsset(assetId));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function revealSelected(): Promise<void> {
		setError(null);
		try {
			if (selectedFolder) await window.loom.revealFolder(selectedFolder);
			else if (selectedAssetId) await window.loom.revealAsset(selectedAssetId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function trashSelection(selection: TreeSelection = picked): Promise<boolean> {
		const items = rootLibraryItems(cursorsForKeys(selection.keys, library.assets));
		if (items.assetIds.length === 0 && items.folders.length === 0) return false;
		return withTrashNotice(() => {
			if (items.assetIds.length === 1 && items.folders.length === 0) return window.loom.trashAsset(items.assetIds[0]);
			if (items.folders.length === 1 && items.assetIds.length === 0) return window.loom.trashFolder(items.folders[0]);
			return window.loom.trashLibraryItems(items.assetIds, items.folders);
		});
	}

	function onLibraryKeyDown(event: React.KeyboardEvent, rows: readonly TreeRow[], folding: boolean): void {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		if (!library.rootPath) return;
		const mod = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		const mac = uiPlatform(navigator.userAgent) === "mac";
		if (event.altKey && mod && event.code === "KeyC") {
			event.preventDefault();
			void copySelectionPaths();
		} else if (event.altKey && mod && event.code === "KeyR") {
			event.preventDefault();
			void revealSelected();
		} else if (mod && !event.altKey && !event.shiftKey && key === "a") {
			event.preventDefault();
			setPicked((current) => selectVisible(current, rows));
		} else if (mod && !event.altKey && key === "c") {
			event.preventDefault();
			copySelection();
		} else if (mod && !event.altKey && key === "x") {
			event.preventDefault();
			cutSelection();
		} else if (mod && !event.altKey && key === "v") {
			event.preventDefault();
			void pasteInto(pasteDestination());
		} else if (mod && !event.altKey && !event.shiftKey && key === "d") {
			event.preventDefault();
			void duplicateSelection();
		} else if (event.key === "F2") {
			event.preventDefault();
			if (picked.keys.length !== 1) return;
			if (selectedFolder) setRenamingFolder(selectedFolder);
			else if (selectedAssetId) setRenamingAssetId(selectedAssetId);
		} else if (mod && event.shiftKey && key === "n") {
			event.preventDefault();
			void createFolderIn(pasteDestination());
		} else if (isLibraryTrashKey(event, mac)) {
			event.preventDefault();
			setError(null);
			void trashSelection()
				.then((removed) => {
					if (removed) clearLibrarySelection();
				})
				.catch((cause) => {
					setError(cause instanceof Error ? cause.message : String(cause));
				});
		} else if (!mod && !event.altKey && event.shiftKey && isExtendKey(event.key)) {
			if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
			event.preventDefault();
			setPicked((current) => extendSelection(current, rows, event.key as "ArrowUp" | "ArrowDown" | "Home" | "End"));
		} else if (!mod && !event.altKey && !event.shiftKey && isTreeNavKey(event.key)) {
			if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
			const motion = treeMotion(rows, libraryCursor(), event.key, folding);
			if (motion.type === "none") {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			if (motion.type === "select") {
				if (motion.cursor.kind === "folder") selectFolder(motion.cursor.relativePath);
				else selectAsset(motion.cursor.assetId);
			} else {
				toggleFolder(motion.relativePath);
			}
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
			selectFolder(await window.loom.renameFolder(relativePath, name));
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
				clearLibrarySelection();
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

	const panelsCollapsed = panels.panelsCollapsed;
	const docked = !panelsCollapsed && panels.hasRegion("dock");
	const bottom = !panelsCollapsed && panels.hasRegion("bottom");
	const beside = !panelsCollapsed && panels.hasRegion("beside");
	const above = !panelsCollapsed && panels.hasRegion("above");
	const collapseOnBottom = !panelsCollapsed && !docked && !beside && bottom;
	const collapseOnAbove = !panelsCollapsed && !docked && !beside && !bottom && above;

	return (
		<CopilotKitProvider runtimeUrl={endpoint.runtimeUrl} agentId={endpoint.agentId} renderActivityMessages={runActivityRenderers}>
			<div className="app">
				{status && (
					<div className={`status-toast${error ? " below" : ""}`} role="status">
						<span className="status-toast-spin" aria-hidden="true" />
						{status}
					</div>
				)}
				{error && <ErrorToast text={error} onDismiss={() => setError(null)} />}
				<div className={`window-bar${uiPlatform(navigator.userAgent) === "mac" ? " mac" : ""}${fullscreen ? " fullscreen" : ""}`}>
					{import.meta.env.DEV ? <TracesButton onOpen={() => void window.loom.openDevTrace?.()} /> : null}
					<SettingsButton onOpen={() => setSettingsOpen(true)} />
					<LibraryOpenButton opening={opening} onOpen={() => void openLibrary()} />
					<SidebarToggle collapsed={libraryCollapsed} onToggle={toggleLibraryCollapsed} />
				</div>

				<div
					className={`shell${libraryCollapsed ? " library-collapsed" : ""}${docked ? "" : " side-hidden"}${bottom ? " has-bottom" : ""}${beside ? " has-beside" : ""}${above ? " has-above" : ""}${panelsCollapsed ? " panels-collapsed" : ""}${collapseOnBottom ? " panel-collapse-bottom" : ""}${collapseOnAbove ? " panel-collapse-above" : ""}${panels.dragDock ? " dock-target" : ""}${panels.lowerFrame ? " lower-target" : ""}${panels.joinFrame ? " join-target" : ""}${panels.spliceFrame ? " splice-target" : ""}${panels.dockSplitFrame ? " dock-split-target" : ""}${panels.joinFrame && meetsWindowCorner(panels.joinFrame, shellRef.current) ? " window-corner" : ""}`}
					ref={shellRef}
					style={{
						...shellStyle,
						...({ "--window-corner": navigator.userAgent.includes("Windows") ? "8px" : "16px" } as CSSProperties),
						...(bottom ? { "--bottom-height": `${panels.bottomHeight}px` } : {}),
						...(above ? { "--above-height": `${panels.aboveHeight}px` } : {}),
						...(panels.dockSplitFrame ? {
							"--dock-split-x": `${panels.dockSplitFrame.x}px`,
							"--dock-split-y": `${panels.dockSplitFrame.y}px`,
							"--dock-split-w": `${panels.dockSplitFrame.width}px`,
							"--dock-split-h": `${panels.dockSplitFrame.height}px`,
						} : {}),
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
						workbenchView={workbenchView}
						onWorkbenchView={setWorkbenchView}
						selectedKeys={selectedKeys}
						focusKey={picked.focus}
						renamingAssetId={renamingAssetId}
						renamingFolder={renamingFolder}
						collapsedFolders={collapsedFolders}
						cutAssetIds={libraryClipboard?.mode === "cut" ? libraryClipboard.assetIds : []}
						cutFolders={libraryClipboard?.mode === "cut" ? libraryClipboard.folders : []}
						selectionDrag={selectionDrag}
						onToggleFolder={toggleFolder}
						onSelectAsset={(assetId, mode, rows) => chooseTreeKey(assetKey(assetId), mode, rows)}
						onSelectFolder={(relativePath, mode, rows) => chooseTreeKey(folderKey(relativePath), mode, rows)}
						onAssetContextMenu={(asset) => void showAssetContextMenu(asset)}
						onFolderContextMenu={(relativePath) => void showFolderContextMenu(relativePath)}
						onLibraryContextMenu={() => void showLibraryContextMenu()}
						onRenameAsset={renameAsset}
						onRenameFolder={renameFolder}
						onCancelRename={cancelRename}
						onDropIntoFolder={(dest, item) => void dropLibraryItem(dest, item)}
						onDropFiles={(dest, files) => void dropExternalFiles(dest, files)}
						onKeyDown={onLibraryKeyDown}
						collapsed={libraryCollapsed}
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
							<AssetPreview
								key={selectedAsset.assetId}
								asset={selectedAsset}
								assets={library.assets}
								onGraded={selectAsset}
								gradeHost={gradeHost}
								grading={grading}
								actions={(
									<PreviewActions
										canGrade={gradeable}
										grading={grading}
										leaveVideo={selectedAsset.type === "video"}
										favorite={library.favoriteAssetIds.includes(selectedAsset.assetId)}
										onGrade={() => {
											setGradingAssetId(selectedAsset.assetId);
											panels.focus("grade");
										}}
										onLeaveGrade={() => setGradingAssetId(null)}
										onToggleFavorite={() => void togglePreviewFavorite(selectedAsset)}
										onDelete={() => void trashPreviewed(selectedAsset.assetId)}
									/>
								)}
							/>
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

					<PanelsToggle collapsed={panelsCollapsed} onToggle={panels.togglePanelsCollapsed} />

					{beside && (
						<div
							className="resize-handle beside-resize"
							role="separator"
							aria-label={t.app.resizeAgent}
							aria-orientation="vertical"
							onPointerDown={(event) => beginResize("beside", event)}
							onDoubleClick={resetBesideWidth}
						/>
					)}

					{docked && (
						<div
							className="resize-handle side-resize"
							role="separator"
							aria-label={t.app.resizeAgent}
							aria-orientation="vertical"
							onPointerDown={(event) => beginResize("side", event)}
							onDoubleClick={resetSideWidth}
						/>
					)}

					{above && (
						<div
							className="resize-handle row above-resize"
							role="separator"
							aria-label={t.app.resizeLower}
							aria-orientation="horizontal"
							onPointerDown={(event) => panels.beginAboveResize(event)}
						/>
					)}

					{bottom && (
						<div
							className="resize-handle row bottom-resize"
							role="separator"
							aria-label={t.app.resizeLower}
							aria-orientation="horizontal"
							onPointerDown={(event) => panels.beginBottomResize(event)}
						/>
					)}

					<PanelWorkspace layout={panels} panels={panelViews} />
				</div>
				{settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
			</div>
		</CopilotKitProvider>
	);
}
