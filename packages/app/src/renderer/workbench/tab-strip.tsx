import { useState } from "react";
import type { Asset } from "@loom/core";
import { draggedAssetIds, endLibraryDrag, hasLibraryDrag, readLibraryDrag } from "../assets/asset-drag.ts";
import { useLocale } from "../locale.tsx";
import { tabLabels, type AssetTabs } from "./asset-tabs.ts";

/**
 * Drag payload for reordering tabs. A type of its own: the file tree and the chat composer read other types,
 * so a tab dropped on them is ignored instead of moving or attaching the file.
 */
export const LOOM_TAB_DRAG = "application/x-loom-tab";

/** Where a dragged tab would land: before the tab with this id, or at the end when null. */
type DropSlot = { beforeId: string | null } | null;

/** Browser-style tabs over the library workbench. A tab holds one file and keeps no view state. */
export function TabStrip({
	tabs,
	assets,
	onActivate,
	onClose,
	onMove,
	onDropFiles,
}: {
	tabs: AssetTabs;
	assets: readonly Asset[];
	onActivate: (assetId: string) => void;
	onClose: (assetId: string) => void;
	onMove: (assetId: string, beforeId: string | null) => void;
	/** Library files dropped on the strip: open them as tabs before `beforeId`, or at the end when null. */
	onDropFiles: (assetIds: string[], beforeId: string | null) => void;
}): React.JSX.Element | null {
	const { t } = useLocale();
	const [dragging, setDragging] = useState<string | null>(null);
	const [slot, setSlot] = useState<DropSlot>(null);
	const files = tabs.ids.flatMap((id) => assets.find((asset) => asset.assetId === id) ?? []);
	if (files.length === 0) return null;
	const labels = tabLabels(files);

	function end(): void {
		setDragging(null);
		setSlot(null);
	}

	/** A tab being reordered, or a library file being carried in. Anything else is not ours. */
	function accepts(transfer: DataTransfer): boolean {
		if (dragging && transfer.types.includes(LOOM_TAB_DRAG)) return true;
		return hasLibraryDrag(transfer);
	}

	function drop(beforeId: string | null, transfer: DataTransfer): void {
		if (dragging && transfer.types.includes(LOOM_TAB_DRAG)) {
			onMove(dragging, beforeId);
			end();
			return;
		}
		const ids = draggedAssetIds(readLibraryDrag(transfer) ?? null);
		endLibraryDrag();
		setSlot(null);
		if (ids.length > 0) onDropFiles(ids, beforeId);
	}

	/** The pointer's side of a tab decides whether the dragged tab lands before it or after it. */
	function slotFor(event: React.DragEvent, index: number): DropSlot {
		const rect = event.currentTarget.getBoundingClientRect();
		const after = event.clientX > rect.left + rect.width / 2;
		const target = after ? (files[index + 1]?.assetId ?? null) : files[index].assetId;
		return { beforeId: target };
	}

	return (
		<div
			className="asset-tabs"
			role="tablist"
			aria-label={t.tabs.label}
			onDragOver={(event) => {
				if (!accepts(event.dataTransfer)) return;
				// Over the empty space after the last tab: land at the end.
				if (event.target === event.currentTarget) {
					event.preventDefault();
					event.dataTransfer.dropEffect = dragging ? "move" : "copy";
					setSlot({ beforeId: null });
				}
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSlot(null);
			}}
			onDrop={(event) => {
				if (!accepts(event.dataTransfer)) return;
				event.preventDefault();
				if (slot) drop(slot.beforeId, event.dataTransfer);
			}}
		>
			{files.map((asset, index) => {
				const selected = asset.assetId === tabs.active;
				const label = labels.get(asset.assetId) ?? asset.filename;
				const marked = slot !== null && slot.beforeId === asset.assetId && dragging !== asset.assetId
					&& files[index - 1]?.assetId !== dragging;
				const markedEnd = slot !== null && slot.beforeId === null && index === files.length - 1
					&& asset.assetId !== dragging;
				return (
					<div
						key={asset.assetId}
						className={`asset-tab${selected ? " active" : ""}${dragging === asset.assetId ? " dragging" : ""}${marked ? " drop-before" : ""}${markedEnd ? " drop-after" : ""}`}
						title={asset.relativePath}
						draggable
						onDragStart={(event) => {
							event.dataTransfer.effectAllowed = "move";
							event.dataTransfer.setData(LOOM_TAB_DRAG, asset.assetId);
							setDragging(asset.assetId);
						}}
						onDragEnd={end}
						onDragOver={(event) => {
							if (!accepts(event.dataTransfer)) return;
							event.preventDefault();
							event.stopPropagation();
							event.dataTransfer.dropEffect = dragging ? "move" : "copy";
							const next = slotFor(event, index);
							if (next?.beforeId !== slot?.beforeId) setSlot(next);
						}}
						onDrop={(event) => {
							if (!accepts(event.dataTransfer)) return;
							event.preventDefault();
							event.stopPropagation();
							const target = slotFor(event, index);
							if (target) drop(target.beforeId, event.dataTransfer);
						}}
					>
						<button
							type="button"
							role="tab"
							aria-selected={selected}
							onClick={() => onActivate(asset.assetId)}
							onMouseDown={(event) => {
								// Windows starts autoscroll on middle press; a middle click closes the tab.
								if (event.button === 1) event.preventDefault();
							}}
							onAuxClick={(event) => {
								if (event.button === 1) onClose(asset.assetId);
							}}
						>
							<span>{label}</span>
						</button>
						<button
							type="button"
							className="asset-tab-close"
							aria-label={t.tabs.close(asset.filename)}
							onClick={() => onClose(asset.assetId)}
						>
							×
						</button>
					</div>
				);
			})}
		</div>
	);
}
