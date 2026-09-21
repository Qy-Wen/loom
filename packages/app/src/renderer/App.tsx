import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import type { Asset, LibraryChange, LibrarySnapshot } from "@loom/core";
import type { AgentEndpoint } from "../shared/ipc.ts";

const EMPTY_LIBRARY: LibrarySnapshot = { rootPath: null, folders: [], assets: [] };
const DEFAULT_LIBRARY_WIDTH = 240;
const DEFAULT_SIDE_WIDTH = 380;
const MIN_LIBRARY_WIDTH = 180;
const MIN_WORKBENCH_WIDTH = 320;
const MIN_SIDE_WIDTH = 300;
const HANDLE_WIDTH = 10;

type SidePanel = "agent" | "details";
type ResizeSide = "library" | "side";

interface FolderNode {
	name: string;
	relativePath: string;
	folders: Map<string, FolderNode>;
	assets: Asset[];
}

function sortAssets(assets: Asset[]): Asset[] {
	return [...assets].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
	if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

function assetPreviewUrl(asset: Asset): string {
	return `loom-asset://asset/${encodeURIComponent(asset.assetId)}?v=${asset.modifiedAt}`;
}

function filenameStem(filename: string): string {
	const extension = extensionOf(filename);
	return extension ? filename.slice(0, -extension.length) : filename;
}

const TEXT_EXTENSIONS = new Set([
	".css", ".csv", ".html", ".ini", ".js", ".json", ".jsx", ".log", ".md",
	".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

function PreviewFallback({ asset, message }: { asset: Asset; message: string }): React.JSX.Element {
	return (
		<div className="preview-placeholder">
			<div className="preview-icon">{asset.type.toUpperCase()}</div>
			<strong>{asset.filename}</strong>
			<span>{message}</span>
		</div>
	);
}

function TextPreview({ asset, url }: { asset: Asset; url: string }): React.JSX.Element {
	const [content, setContent] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setContent(null);
		setFailure(null);
		if (asset.size > 2 * 1_024 * 1_024) {
			setFailure("This text file is larger than 2 MB, so inline preview is disabled.");
			return () => controller.abort();
		}
		void fetch(url, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
				return response.text();
			})
			.then(setContent)
			.catch((cause) => {
				if (!controller.signal.aborted) {
					setFailure(cause instanceof Error ? cause.message : String(cause));
				}
			});
		return () => controller.abort();
	}, [asset.assetId, asset.size, url]);

	if (failure) return <PreviewFallback asset={asset} message={failure} />;
	if (content === null) return <div className="preview-loading">Loading text preview…</div>;
	return <pre className="text-preview">{content}</pre>;
}

function AssetPreview({ asset }: { asset: Asset }): React.JSX.Element {
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);
	const extension = extensionOf(asset.filename);

	useEffect(() => setFailed(false), [asset.assetId]);

	if (failed) {
		return <PreviewFallback asset={asset} message="This file format could not be previewed by Electron." />;
	}
	if (asset.type === "image") {
		return (
			<div className="media-preview image-preview">
				<img src={url} alt={asset.filename} onError={() => setFailed(true)} />
			</div>
		);
	}
	if (asset.type === "video") {
		return (
			<div className="media-preview video-preview">
				<video key={url} controls preload="metadata" onError={() => setFailed(true)}>
					<source src={url} />
				</video>
			</div>
		);
	}
	if (asset.type === "audio") {
		return (
			<div className="audio-preview">
				<div className="audio-art">♪</div>
				<strong>{asset.filename}</strong>
				<audio key={url} controls preload="metadata" onError={() => setFailed(true)}>
					<source src={url} />
				</audio>
			</div>
		);
	}
	if (extension === ".pdf") {
		return <iframe className="pdf-preview" src={url} title={`Preview ${asset.filename}`} />;
	}
	if (TEXT_EXTENSIONS.has(extension)) return <TextPreview asset={asset} url={url} />;
	return <PreviewFallback asset={asset} message="No inline preview is available for this format yet." />;
}

function applyLibraryChange(current: LibrarySnapshot, change: LibraryChange): LibrarySnapshot {
	if (change.type === "reset") return change.snapshot;
	if (change.type === "error") return current;
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

function buildFileTree(snapshot: LibrarySnapshot): FolderNode {
	const root: FolderNode = { name: "", relativePath: "", folders: new Map(), assets: [] };

	const ensureFolder = (relativePath: string): FolderNode => {
		let current = root;
		let currentPath = "";
		for (const name of relativePath.split("/").filter(Boolean)) {
			currentPath = currentPath ? `${currentPath}/${name}` : name;
			let child = current.folders.get(name);
			if (!child) {
				child = { name, relativePath: currentPath, folders: new Map(), assets: [] };
				current.folders.set(name, child);
			}
			current = child;
		}
		return current;
	};

	for (const folder of snapshot.folders) ensureFolder(folder);
	for (const asset of snapshot.assets) {
		const parts = asset.relativePath.split("/");
		parts.pop();
		ensureFolder(parts.join("/")).assets.push(asset);
	}
	return root;
}

function AssetThumbnail({ asset }: { asset: Asset }): React.JSX.Element {
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);

	if (!failed && asset.type === "image") {
		return (
			<span className="asset-thumbnail media-thumbnail">
				<img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
			</span>
		);
	}
	if (!failed && asset.type === "video") {
		return (
			<span className="asset-thumbnail media-thumbnail video-thumbnail">
				<video
					src={url}
					muted
					preload="metadata"
					onLoadedMetadata={(event) => {
						const video = event.currentTarget;
						if (video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
					}}
					onError={() => setFailed(true)}
				/>
			</span>
		);
	}

	const label = asset.type === "audio"
		? "♪"
		: extensionOf(asset.filename).slice(1, 4).toUpperCase() || asset.type[0].toUpperCase();
	return <span className={`asset-thumbnail asset-badge type-${asset.type}`}>{label}</span>;
}

interface AssetTreeRowProps {
	asset: Asset;
	depth: number;
	selected: boolean;
	renaming: boolean;
	onSelect: () => void;
	onContextMenu: () => void;
	onRename: (stem: string) => Promise<void>;
	onCancelRename: () => void;
}

function AssetTreeRow({
	asset,
	depth,
	selected,
	renaming,
	onSelect,
	onContextMenu,
	onRename,
	onCancelRename,
}: AssetTreeRowProps): React.JSX.Element {
	const [stem, setStem] = useState(() => filenameStem(asset.filename));
	const cancelled = useRef(false);

	useEffect(() => setStem(filenameStem(asset.filename)), [asset.filename]);

	if (renaming) {
		return (
			<div className={`asset-row rename-row ${selected ? "selected" : ""}`} style={{ paddingLeft: 7 + depth * 14 }}>
				<AssetThumbnail asset={asset} />
				<div className="rename-editor">
					<input
						autoFocus
						value={stem}
						onChange={(event) => setStem(event.target.value)}
						onFocus={(event) => event.currentTarget.select()}
						onKeyDown={(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
							if (event.key === "Escape") {
								cancelled.current = true;
								onCancelRename();
								event.currentTarget.blur();
							}
						}}
						onBlur={() => {
							if (!cancelled.current) void onRename(stem);
						}}
					/>
					<span>{extensionOf(asset.filename)}</span>
				</div>
			</div>
		);
	}

	return (
		<button
			className={`asset-row ${selected ? "selected" : ""}`}
			style={{ paddingLeft: 7 + depth * 14 }}
			type="button"
			onClick={onSelect}
			onContextMenu={(event) => {
				event.preventDefault();
				onContextMenu();
			}}
		>
			<AssetThumbnail asset={asset} />
			<span className="asset-name" title={asset.relativePath}>{asset.filename}</span>
		</button>
	);
}

interface FileTreeRowsProps {
	node: FolderNode;
	depth?: number;
	collapsedFolders: Set<string>;
	selectedAssetId: string | null;
	renamingAssetId: string | null;
	onToggleFolder: (relativePath: string) => void;
	onSelectAsset: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
}

function FileTreeRows({
	node,
	depth = 0,
	collapsedFolders,
	selectedAssetId,
	renamingAssetId,
	onToggleFolder,
	onSelectAsset,
	onAssetContextMenu,
	onRenameAsset,
	onCancelRename,
}: FileTreeRowsProps): React.JSX.Element {
	const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
	const assets = sortAssets(node.assets);

	return (
		<>
			{folders.map((folder) => {
				const collapsed = collapsedFolders.has(folder.relativePath);
				return (
					<div key={folder.relativePath}>
						<button
							className="folder-row"
							style={{ paddingLeft: 7 + depth * 14 }}
							type="button"
							onClick={() => onToggleFolder(folder.relativePath)}
						>
							<span className="folder-chevron">{collapsed ? "›" : "⌄"}</span>
							<span className="folder-symbol">▰</span>
							<span className="asset-name">{folder.name}</span>
						</button>
						{!collapsed && (
							<FileTreeRows
								node={folder}
								depth={depth + 1}
								collapsedFolders={collapsedFolders}
								selectedAssetId={selectedAssetId}
								renamingAssetId={renamingAssetId}
								onToggleFolder={onToggleFolder}
								onSelectAsset={onSelectAsset}
								onAssetContextMenu={onAssetContextMenu}
								onRenameAsset={onRenameAsset}
								onCancelRename={onCancelRename}
							/>
						)}
					</div>
				);
			})}
			{assets.map((asset) => (
				<AssetTreeRow
					key={asset.assetId}
					asset={asset}
					depth={depth}
					selected={asset.assetId === selectedAssetId}
					renaming={asset.assetId === renamingAssetId}
					onSelect={() => onSelectAsset(asset.assetId)}
					onContextMenu={() => onAssetContextMenu(asset)}
					onRename={(stem) => onRenameAsset(asset, stem)}
					onCancelRename={onCancelRename}
				/>
			))}
		</>
	);
}

export function App(): React.JSX.Element {
	const [endpoint, setEndpoint] = useState<AgentEndpoint | null>(null);
	const [library, setLibrary] = useState<LibrarySnapshot>(EMPTY_LIBRARY);
	const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
	const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
	const [sidePanel, setSidePanel] = useState<SidePanel>("agent");
	const [libraryWidth, setLibraryWidth] = useState(() =>
		Number(localStorage.getItem("loom.layout.libraryWidth")) || DEFAULT_LIBRARY_WIDTH,
	);
	const [sideWidth, setSideWidth] = useState(() =>
		Number(localStorage.getItem("loom.layout.sideWidth")) || DEFAULT_SIDE_WIDTH,
	);
	const shellRef = useRef<HTMLDivElement>(null);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void window.loom.getAgentEndpoint().then(setEndpoint).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
		});
		void window.loom.getLibrarySnapshot().then(setLibrary).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
		});

		return window.loom.onLibraryChanged((change) => {
			if (change.type === "error") setError(change.message);
			else setLibrary((current) => applyLibraryChange(current, change));
		});
	}, []);

	useEffect(() => {
		localStorage.setItem("loom.layout.libraryWidth", String(libraryWidth));
	}, [libraryWidth]);

	useEffect(() => {
		localStorage.setItem("loom.layout.sideWidth", String(sideWidth));
	}, [sideWidth]);

	const selectedAsset = useMemo(
		() => library.assets.find((asset) => asset.assetId === selectedAssetId) ?? null,
		[library.assets, selectedAssetId],
	);
	const fileTree = useMemo(() => buildFileTree(library), [library]);

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

	function beginResize(side: ResizeSide, event: ReactPointerEvent<HTMLDivElement>): void {
		if (event.button !== 0 || !shellRef.current) return;
		event.preventDefault();
		const bounds = shellRef.current.getBoundingClientRect();
		document.body.classList.add("resizing-columns");

		const onPointerMove = (moveEvent: PointerEvent) => {
			if (side === "library") {
				const maximum = Math.max(
					MIN_LIBRARY_WIDTH,
					Math.min(360, bounds.width - sideWidth - MIN_WORKBENCH_WIDTH - HANDLE_WIDTH * 2),
				);
				setLibraryWidth(Math.min(maximum, Math.max(MIN_LIBRARY_WIDTH, moveEvent.clientX - bounds.left)));
			} else {
				const maximum = Math.max(
					MIN_SIDE_WIDTH,
					Math.min(520, bounds.width - libraryWidth - MIN_WORKBENCH_WIDTH - HANDLE_WIDTH * 2),
				);
				setSideWidth(Math.min(maximum, Math.max(MIN_SIDE_WIDTH, bounds.right - moveEvent.clientX)));
			}
		};

		const onPointerUp = () => {
			document.body.classList.remove("resizing-columns");
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
	}

	async function openLibrary(): Promise<void> {
		setOpening(true);
		setError(null);
		try {
			const snapshot = await window.loom.openLibrary();
			if (snapshot) {
				setLibrary(snapshot);
				setSelectedAssetId(null);
				setRenamingAssetId(null);
				setCollapsedFolders(new Set());
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
						<button className="active" type="button">Library</button>
						<button type="button" disabled>Gallery</button>
						<button type="button" disabled>Table</button>
						<button type="button" disabled>Graph</button>
					</nav>
					<div className="topbar-spacer" />
				</header>

				{error && <div className="error-banner">{error}</div>}

				<div
					className="shell"
					ref={shellRef}
					style={{
						"--library-width": `${libraryWidth}px`,
						"--side-width": `${sideWidth}px`,
					} as CSSProperties}
				>
					<aside className="library-sidebar">
						<div className="library-header">
							<div>
								<div className="section-label">Asset Library</div>
								<div className="library-name" title={library.rootPath ?? undefined}>
									{library.rootPath?.split("/").filter(Boolean).at(-1) ?? "No folder open"}
								</div>
							</div>
							<button className="open-button" type="button" onClick={openLibrary} disabled={opening}>
								{opening ? "…" : "Open"}
							</button>
						</div>
						{library.rootPath && (
							<div className="library-path" title={library.rootPath}>{library.rootPath}</div>
						)}

						<div className="file-heading">
							<span>Files</span>
							<span>{library.assets.length}</span>
						</div>
						{!library.rootPath ? (
							<div className="empty">Open a folder to start a local asset library.</div>
						) : library.assets.length === 0 && library.folders.length === 0 ? (
							<div className="empty">This folder is empty.</div>
						) : (
							<div className="asset-list">
								<FileTreeRows
									node={fileTree}
									collapsedFolders={collapsedFolders}
									selectedAssetId={selectedAssetId}
									renamingAssetId={renamingAssetId}
									onToggleFolder={toggleFolder}
									onSelectAsset={setSelectedAssetId}
									onAssetContextMenu={(asset) => void showAssetContextMenu(asset)}
									onRenameAsset={renameAsset}
									onCancelRename={() => setRenamingAssetId(null)}
								/>
							</div>
						)}
					</aside>

					<div
						className="resize-handle"
						role="separator"
						aria-label="Resize asset library"
						aria-orientation="vertical"
						onPointerDown={(event) => beginResize("library", event)}
						onDoubleClick={() => setLibraryWidth(DEFAULT_LIBRARY_WIDTH)}
					/>

					<main className="workbench">
						{selectedAsset ? (
							<>
								<header className="asset-toolbar">
									<div className="asset-title-group">
										<strong>{selectedAsset.filename}</strong>
										<span title={selectedAsset.relativePath}>{selectedAsset.relativePath}</span>
									</div>
									<div className="asset-summary">
										<span>{selectedAsset.type}</span>
										<span>{formatBytes(selectedAsset.size)}</span>
										<button type="button" onClick={() => setSidePanel("details")}>Details</button>
									</div>
								</header>
								<AssetPreview key={selectedAsset.assetId} asset={selectedAsset} />
							</>
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
									<button className="primary-button" type="button" onClick={openLibrary} disabled={opening}>
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
						onDoubleClick={() => setSideWidth(DEFAULT_SIDE_WIDTH)}
					/>

					<aside className="side-panel">
						<div className="panel-tabs">
							<button
								className={sidePanel === "agent" ? "active" : ""}
								type="button"
								onClick={() => setSidePanel("agent")}
							>Agent</button>
							<button
								className={sidePanel === "details" ? "active" : ""}
								type="button"
								onClick={() => setSidePanel("details")}
							>Details</button>
						</div>

						<div className={`panel-content agent-content ${sidePanel === "agent" ? "active" : ""}`}>
							<CopilotChat />
						</div>

						<div className={`panel-content details-content ${sidePanel === "details" ? "active" : ""}`}>
							<section>
								<div className="section-label">Properties</div>
								{selectedAsset ? (
									<dl className="properties">
										<dt>Type</dt><dd>{selectedAsset.type}</dd>
										<dt>Size</dt><dd>{formatBytes(selectedAsset.size)}</dd>
										<dt>Modified</dt><dd>{new Date(selectedAsset.modifiedAt).toLocaleString()}</dd>
										<dt>Asset ID</dt><dd title={selectedAsset.assetId}>{selectedAsset.assetId}</dd>
									</dl>
								) : (
									<div className="empty no-padding">Select an asset to see its properties.</div>
								)}
							</section>
							<section className="relations-section">
								<div className="section-label">Relations</div>
								<div className="empty no-padding">No relations yet.</div>
							</section>
						</div>
					</aside>
				</div>
			</div>
		</CopilotKitProvider>
	);
}
