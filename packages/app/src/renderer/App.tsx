import { useEffect, useMemo, useState } from "react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import type { Asset, LibraryChange, LibrarySnapshot } from "@loom/core";
import type { AgentEndpoint } from "../shared/ipc.ts";
import { AssetPreview } from "./asset-preview.tsx";
import { sortAssets } from "./asset-utils.ts";
import { folderSet } from "./file-tree.tsx";
import { LibrarySidebar } from "./library-sidebar.tsx";
import { SidePanel, type SidePanelTab } from "./side-panel.tsx";
import { useResizableLayout } from "./use-resizable-layout.ts";

const EMPTY_LIBRARY: LibrarySnapshot = { rootPath: null, folders: [], assets: [] };

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

export function App(): React.JSX.Element {
	const [endpoint, setEndpoint] = useState<AgentEndpoint | null>(null);
	const [library, setLibrary] = useState<LibrarySnapshot>(EMPTY_LIBRARY);
	const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
	const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
	const [sidePanel, setSidePanel] = useState<SidePanelTab>("agent");
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);
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
		void window.loom.getLibrarySnapshot().then((snapshot) => {
			setLibrary(snapshot);
			setCollapsedFolders(folderSet(snapshot));
		}).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
		});

		return window.loom.onLibraryChanged((change) => {
			if (change.type === "error") {
				setError(change.message);
				return;
			}
			setLibrary((current) => applyLibraryChange(current, change));
			if (change.type === "reset") setCollapsedFolders(folderSet(change.snapshot));
			if (change.type === "folder_upsert") {
				setCollapsedFolders((current) => new Set(current).add(change.relativePath));
			}
		});
	}, []);

	const selectedAsset = useMemo(
		() => library.assets.find((asset) => asset.assetId === selectedAssetId) ?? null,
		[library.assets, selectedAssetId],
	);

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

	async function openLibrary(): Promise<void> {
		setOpening(true);
		setError(null);
		try {
			const snapshot = await window.loom.openLibrary();
			if (snapshot) {
				setLibrary(snapshot);
				setSelectedAssetId(null);
				setRenamingAssetId(null);
				setCollapsedFolders(folderSet(snapshot));
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
						{selectedAsset ? (
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

					<SidePanel activeTab={sidePanel} asset={selectedAsset} onChangeTab={setSidePanel} />
				</div>
			</div>
		</CopilotKitProvider>
	);
}
