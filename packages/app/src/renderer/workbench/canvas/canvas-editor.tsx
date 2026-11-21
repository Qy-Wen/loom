import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { Asset } from "@loom/core";
import { isCanvasLibraryPath, removeCanvasElements, type CanvasNode, type CanvasSide } from "../../../shared/canvas.ts";
import { draggedAssetIds, endLibraryDrag, hasLibraryDrag, readLibraryDrag } from "../../assets/asset-drag.ts";
import { assetPosterUrl } from "../../assets/asset-utils.ts";
import { useConfirmation } from "../../components/confirm-dialog.tsx";
import { isImeComposing } from "../../components/ime-composition.ts";
import { LibraryFileSearch } from "../../components/library-file-search.tsx";
import { useLocale } from "../../locale.tsx";
import { rectBetween, rectsIntersect, type Rect } from "../browser/folder-browser-model.ts";
import { CANVAS_CARD_HEADER_HEIGHT, CanvasCard } from "./canvas-card.tsx";
import { CanvasConnections } from "./canvas-connections.tsx";
import { CanvasAction, CanvasSelectionControls, CanvasToolbar } from "./canvas-controls.tsx";
import { connectionCurve, containsCard, edgeCurve, edgePoint, fitMediaNode, fitNodes, movingCards, nodeBounds, reshapeNode, worldPoint, zoomAt, type Point, type Viewport } from "./canvas-layout.ts";
import { useCanvasDocument } from "./use-canvas-document.ts";
import { useCanvasDrag } from "./use-canvas-drag.ts";
import "./canvas.css";

const EMPTY_NODES: CanvasNode[] = [];
const ARROW_STEPS: Record<string, Point> = {
	ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
};

export function CanvasEditor({ asset, assets, incoming, onConsume, onPreview, onError }: {
	asset: Asset;
	assets: Asset[];
	incoming?: readonly string[];
	onConsume: () => void;
	onPreview: (asset: Asset) => void;
	onError: (error: string) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const { confirm } = useConfirmation();
	const board = useCanvasDocument(asset.assetId);
	const surface = useRef<HTMLDivElement>(null);
	const docks = useRef<HTMLDivElement>(null);
	const capture = useCanvasDrag(surface);
	const [view, setView] = useState<Viewport>({ x: 36, y: 36, scale: 1 });
	const [pan, setPan] = useState(false);
	const space = useRef(false);
	const ready = useRef(false);
	const consumed = useRef<readonly string[] | undefined>(undefined);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [edgeId, setEdgeId] = useState<string | null>(null);
	const [connection, setConnection] = useState<{ id: string; side?: CanvasSide } | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [fileSearch, setFileSearch] = useState<{ point: Point } | { replaceId: string } | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [box, setBox] = useState<Rect | null>(null);
	const [shift, setShift] = useState<{ ids: ReadonlySet<string>; delta: Point; resize: boolean; ratio?: number } | null>(null);
	const [mediaRatios, setMediaRatios] = useState<ReadonlyMap<string, number>>(() => new Map());
	const byId = useMemo(() => new Map(assets.map((file) => [file.assetId, file])), [assets]);
	const byPath = useMemo(() => new Map(assets.map((file) => [file.relativePath, file])), [assets]);
	const searchableFiles = useMemo(() => assets.filter((file) => isCanvasLibraryPath(file.relativePath)), [assets]);
	const nodes = board.document?.nodes ?? EMPTY_NODES;
	const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
	const layoutNodes = mediaRatios.size ? nodes.map((node) => fitMediaNode(node, mediaRatioForNode(node))) : nodes;
	const visibleNodes = shift ? nodes.map((node, index) => {
		if (!shift.ids.has(node.id)) return layoutNodes[index]!;
		return shift.resize
			? fitMediaNode(reshapeNode(node, shift.delta, true, shift.ratio), shift.ratio)
			: reshapeNode(layoutNodes[index]!, shift.delta, false);
	}) : layoutNodes;
	const selectedNodes = [...selected].filter((id) => nodeIds.has(id));
	const selection = visibleNodes.find((node) => node.id === selectedNodes.at(-1));
	const single = selectedNodes.length === 1 ? selection : undefined;
	const edge = board.document?.edges.find((item) => item.id === edgeId);
	const from = edge && visibleNodes.find((node) => node.id === edge.fromNode);
	const to = edge && visibleNodes.find((node) => node.id === edge.toNode);
	const midpoint = edge && from && to ? edgeCurve(edge, from, to).midpoint : undefined;
	const anchor = selection ?? (midpoint && { ...midpoint, width: 0, height: 0 });
	const anchorTopInset = selection ? CANVAS_CARD_HEADER_HEIGHT : 0;
	const preview = single && assetForNode(single);
	const canEdit = single && (single.type === "text" || single.type === "group");
	const isEditing = canEdit && editing === single.id;

	function assetForNode(node: CanvasNode): Asset | undefined {
		return node.loom?.assetId ? byId.get(node.loom.assetId) : node.file ? byPath.get(node.file) : undefined;
	}

	function mediaRatioForNode(node: CanvasNode): number | undefined {
		const file = node.type === "file" ? assetForNode(node) : undefined;
		if (file?.type === "image" || file?.type === "video") return mediaRatios.get(assetPosterUrl(file));
	}

	function recordMediaSize(file: Asset, width: number, height: number): void {
		if (width <= 0 || height <= 0) return;
		const key = assetPosterUrl(file);
		const ratio = width / height;
		setMediaRatios((current) => current.get(key) === ratio ? current : new Map(current).set(key, ratio));
	}

	function fit(): void {
		const element = surface.current;
		if (!element) return;
		const footerHeight = (docks.current?.offsetHeight ?? 0) + 12;
		setView(fitNodes(layoutNodes, element.clientWidth, element.clientHeight - footerHeight));
	}

	useLayoutEffect(() => {
		if (!ready.current && board.document) {
			ready.current = true;
			fit();
		}
	}, [board.document]);

	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		function wheel(event: WheelEvent): void {
			const scroller = event.target instanceof Element && event.target.closest("textarea, .canvas-note");
			if (!event.ctrlKey && !event.metaKey && scroller && scroller.scrollHeight > scroller.clientHeight) return;
			event.preventDefault();
			if (capture.drag.current) return;
			const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (element?.clientHeight ?? 1) : 1;
			if (event.ctrlKey || event.metaKey) {
				const bounds = element!.getBoundingClientRect();
				const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
				setView((current) => zoomAt(current, point, Math.exp(-event.deltaY * scale * 0.005)));
			} else {
				setView((current) => ({ ...current, x: current.x - event.deltaX * scale, y: current.y - event.deltaY * scale }));
			}
		}
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, []);

	useEffect(() => {
		if (!incoming || !board.document || consumed.current === incoming) return;
		consumed.current = incoming;
		addFiles(incoming, centerPoint());
		onConsume();
	}, [incoming, board.document]);

	function centerPoint(): Point {
		const element = surface.current;
		return worldPoint(view, { x: (element?.clientWidth ?? 400) / 2, y: (element?.clientHeight ?? 300) / 2 });
	}

	function documentPoint(event: { clientX: number; clientY: number }): Point {
		const bounds = surface.current?.getBoundingClientRect();
		return worldPoint(view, { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) });
	}

	function append(added: CanvasNode[], behind = false): void {
		const current = board.live.current?.document;
		if (!current || !added.length) return;
		board.commit({ ...current, nodes: behind ? [...added, ...current.nodes] : [...current.nodes, ...added] });
		setSelected(new Set(added.map((node) => node.id)));
		setEdgeId(null);
		setConnection(null);
		setEditing(null);
	}

	function addFiles(ids: readonly string[], point: Point): void {
		const files = [...new Set(ids)].flatMap((id) => {
			const file = byId.get(id);
			return file && isCanvasLibraryPath(file.relativePath) ? [file] : [];
		});
		append(files.map((file, index) => ({
			id: crypto.randomUUID(), type: "file",
			x: Math.round(point.x + (index % 3) * 260), y: Math.round(point.y + Math.floor(index / 3) * 188),
			width: 244, height: 172, file: file.relativePath, loom: { assetId: file.assetId },
		})));
		surface.current?.focus();
	}

	async function openCanvasMenu(event: MouseEvent<HTMLDivElement>): Promise<void> {
		const target = event.target;
		if (!board.document || event.defaultPrevented || !(target instanceof Element)
			|| target.closest("a, audio, video, input, textarea, select, [contenteditable='true']")) return;
		const card = target.closest<HTMLElement>(".canvas-card[data-node-id]");
		const canGroup = selectedNodes.length > 1 && (!card || selectedNodes.includes(card.dataset.nodeId ?? ""));
		if (target.closest(".canvas-node, button") && (!card || !canGroup)) return;
		event.preventDefault();
		const point = event.clientX === 0 && event.clientY === 0 ? centerPoint() : documentPoint(event);
		surface.current?.focus({ preventScroll: true });
		try {
			const action = await window.loom.showCanvasContextMenu(canGroup);
			if (!surface.current) return;
			if (action === "add_files") setFileSearch({ point });
			else if (action === "group" && canGroup) groupSelection(selectedNodes);
		} catch (cause) {
			onError(String(cause));
		}
	}

	function finishFileSearch(file: Asset | null): void {
		setFileSearch(null);
		if (!fileSearch || !file) return;
		if ("point" in fileSearch) {
			addFiles([file.assetId], fileSearch.point);
		} else {
			patchNode(fileSearch.replaceId, (node) => ({
				...node, file: file.relativePath, loom: { ...node.loom, assetId: file.assetId },
			}));
		}
	}

	function addTextCard(point = centerPoint()): void {
		const id = crypto.randomUUID();
		const x = Math.round(point.x - 120), y = Math.round(point.y - 60);
		append([{ id, type: "text", x, y, width: 260, height: 160, text: "" }]);
		setEditing(id);
	}

	function groupSelection(ids: readonly string[]): void {
		const picked = new Set(ids);
		const cards = board.live.current?.document.nodes.filter((node) => picked.has(node.id));
		if (!cards || cards.length < 2) return;
		const bounds = nodeBounds(cards.map((node) => fitMediaNode(node, mediaRatioForNode(node))))!;
		const padding = 32;
		const id = crypto.randomUUID();
		append([{
			id, type: "group", label: t.canvas.group,
			x: bounds.x - padding, y: bounds.y - padding,
			width: Math.ceil(bounds.width) + padding * 2, height: Math.ceil(bounds.height) + padding * 2,
		}], true);
		setEditing(id);
	}

	function editCard(id: string | null): void {
		setEditing(id);
		if (id === null) {
			board.endGroup();
			surface.current?.focus({ preventScroll: true });
		} else {
			setSelected(new Set([id]));
			setEdgeId(null);
			setConnection(null);
		}
	}

	function patchNode(id: string, patch: (node: CanvasNode) => CanvasNode, group?: string): void {
		const current = board.live.current?.document;
		if (current) board.commit({ ...current, nodes: current.nodes.map((node) => node.id === id ? patch(node) : node) }, group);
	}

	function selectNode(id: string, add: boolean): Set<string> {
		if (connection && nodeIds.has(connection.id) && !add) {
			if (connection.id !== id) addEdge(connection.id, id, connection.side);
			return new Set();
		}
		const next = add ? new Set(selected) : selected.has(id) ? selected : new Set<string>();
		if (add && next.has(id)) next.delete(id);
		else next.add(id);
		setSelected(next);
		setEdgeId(null);
		setConnection(null);
		if (editing !== id || add) setEditing(null);
		return next;
	}

	function transform(ids: ReadonlySet<string>, delta: Point, resize: boolean, ratio?: number): void {
		if (Math.round(delta.x) === 0 && Math.round(delta.y) === 0) return;
		const current = board.live.current?.document;
		if (current) board.commit({ ...current, nodes: current.nodes.map((node) => ids.has(node.id) ? reshapeNode(node, delta, resize, ratio) : node) });
	}

	function dragNode(event: PointerEvent, node: CanvasNode, resize: boolean): void {
		if (event.button !== 0 || capture.drag.current) return;
		const { id } = node;
		event.preventDefault();
		const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
		(target ?? event.currentTarget.querySelector<HTMLButtonElement>(".canvas-handle"))?.focus({ preventScroll: true });
		const picked = resize ? new Set([id]) : selectNode(id, event.shiftKey || event.metaKey || event.ctrlKey);
		if (!picked.has(id)) return;
		if (resize) { setSelected(picked); setEdgeId(null); }
		const ids = resize ? picked : movingCards(layoutNodes, picked);
		const ratio = resize ? mediaRatioForNode(node) : undefined;
		const scale = (delta: Point) => ({ x: delta.x / view.scale, y: delta.y / view.scale });
		capture.begin(event, (delta) => setShift({ ids, delta: scale(delta), resize, ratio }), (delta) => {
			setShift(null);
			if (delta) transform(ids, scale(delta), resize, ratio);
		}, resize ? 0 : 4);
	}

	function pointerDown(event: PointerEvent<HTMLDivElement>): void {
		const movingViewport = event.button === 1 || (event.button === 0 && (pan || space.current));
		if (!movingViewport && (event.button !== 0 || (event.target instanceof Element && event.target.closest(".canvas-card, button")))) return;
		event.preventDefault();
		surface.current?.focus({ preventScroll: true });
		if (movingViewport) {
			const moved = (delta: Point) => setView({ ...view, x: view.x + delta.x, y: view.y + delta.y });
			capture.begin(event, moved, (delta) => { if (delta) moved(delta); });
			return;
		}
		const origin = documentPoint(event);
		const base = event.shiftKey || event.metaKey || event.ctrlKey ? selected : new Set<string>();
		const rectangle = (delta: Point) => rectBetween(origin.x, origin.y, origin.x + delta.x / view.scale, origin.y + delta.y / view.scale);
		setEdgeId(null);
		setConnection(null);
		setEditing(null);
		capture.begin(event, (delta) => setBox(rectangle(delta)), (delta) => {
			setBox(null);
			if (!delta) return;
			const area = rectangle(delta);
			const boxed = Math.hypot(delta.x, delta.y) < 4 ? [] : layoutNodes
				.filter((node) => node.type === "group" ? containsCard(area, node) : rectsIntersect(area, node))
				.map((node) => node.id);
			setSelected(new Set([...base, ...boxed]));
		});
	}

	function addEdge(fromNode: string, toNode: string, fromSide?: CanvasSide): void {
		const current = board.live.current?.document;
		if (!current || fromNode === toNode || !current.nodes.some((node) => node.id === fromNode)
			|| !current.nodes.some((node) => node.id === toNode)) return;
		const id = crypto.randomUUID();
		board.commit({ ...current, edges: [...current.edges, { id, fromNode, toNode, ...(fromSide && { fromSide }) }] });
		setEdgeId(id);
		setSelected(new Set());
		setConnection(null);
		setEditing(null);
		surface.current?.focus({ preventScroll: true });
	}

	function startConnection(id: string, side?: CanvasSide): void {
		setConnection(connection?.id === id && connection.side === side ? null : { id, side });
	}

	function dragConnection(event: PointerEvent, node: CanvasNode, side: CanvasSide): void {
		if (event.button !== 0 || event.defaultPrevented || capture.drag.current) return;
		const origin = { clientX: event.clientX, clientY: event.clientY };
		const start = edgePoint(node, side);
		const cursor = (delta: Point) => ({ clientX: origin.clientX + delta.x, clientY: origin.clientY + delta.y });
		capture.begin(event, (delta) => {
			setDraft(connectionCurve(start, side, documentPoint(cursor(delta))).path);
		}, (delta) => {
			setDraft(null);
			if (!delta) return;
			const { clientX, clientY } = cursor(delta);
			const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".canvas-card");
			if (target?.dataset.nodeId && surface.current?.contains(target)) addEdge(node.id, target.dataset.nodeId, side);
		}, 4);
	}

	function removeSelection(): void {
		const current = board.live.current?.document;
		if (!current || (!selectedNodes.length && !edge)) return;
		board.commit(removeCanvasElements(current, new Set(selectedNodes), new Set(edge ? [edge.id] : [])));
		setSelected(new Set());
		setEdgeId(null);
		setConnection(null);
		setEditing(null);
		surface.current?.focus({ preventScroll: true });
	}

	function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
		const target = event.target;
		if (event.defaultPrevented || isImeComposing(event.nativeEvent)
			|| (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))) return;
		const mod = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) board.redo(); else board.undo(); }
		else if (mod && key === "y") { event.preventDefault(); board.redo(); }
		else if (mod && key === "a") { event.preventDefault(); setSelected(new Set(nodes.map((node) => node.id))); setEdgeId(null); setConnection(null); }
		else if (key === "delete" || key === "backspace") { event.preventDefault(); removeSelection(); }
		else if (key === "escape") {
			if (connection) {
				event.stopPropagation();
				setConnection(null);
			} else {
				setSelected(new Set()); setEdgeId(null); setEditing(null);
			}
		}
		else if (key === " " && target === surface.current) { event.preventDefault(); space.current = true; }
	}

	async function reload(): Promise<void> {
		if (board.saving && !await confirm({ title: t.canvas.reloadConfirm, description: t.canvas.reloadDetail, confirmLabel: t.canvas.reload, tone: "warning" })) return;
		await board.reload();
	}

	function zoom(ratio: number): void {
		const element = surface.current;
		if (element) setView((current) => zoomAt(current, { x: element.clientWidth / 2, y: element.clientHeight / 2 }, ratio));
	}

	return (
		<section className="canvas-editor" aria-label={`${t.canvas.canvas} ${asset.filename}`} onKeyDown={keyDown}>
			{board.error && <div className="canvas-save-error" role="alert">
				<span>{board.conflict ? t.canvas.conflict : board.error}</span>
				{board.saving && !board.conflict && <button type="button" onClick={board.retry}>{t.canvas.retry}</button>}
				<button type="button" onClick={() => void reload()}>{t.canvas.reload}</button>
			</div>}
			<div className="canvas-viewport">
				<div ref={surface} className={`canvas-surface${pan ? " pan" : ""}${connection ? " connecting" : ""}`} tabIndex={0} aria-label={t.canvas.canvas}
					style={{ "--canvas-scale": view.scale, backgroundPosition: `${view.x}px ${view.y}px` } as CSSProperties}
					onContextMenu={(event) => void openCanvasMenu(event)}
					onPointerDownCapture={(event) => { if (pan || space.current || event.button === 1) pointerDown(event); }}
					onPointerDown={(event) => { if (!event.defaultPrevented) pointerDown(event); }}
					onPointerMove={capture.move} onPointerUp={(event) => capture.end(event)}
					onPointerCancel={(event) => capture.end(event, true)}
					onPointerLeave={(event) => { if (!capture.drag.current?.started) capture.end(event, true); }}
					onLostPointerCapture={(event) => { if (event.target === event.currentTarget) capture.end(event, true); }}
					onKeyUp={(event) => { if (event.key === " ") space.current = false; }}
					onBlur={() => { space.current = false; }}
					onDoubleClick={(event) => {
						if (!board.document || pan || event.button !== 0 || !(event.target instanceof Element)
							|| event.target.closest(".canvas-node, button")) return;
						const point = documentPoint(event);
						addTextCard({ x: point.x + 120, y: point.y + 60 });
					}}
					onDragOver={(event) => {
						if (!board.document || !hasLibraryDrag(event.dataTransfer)) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
					}}
					onDrop={(event) => {
						if (!board.document || !hasLibraryDrag(event.dataTransfer)) return;
						event.preventDefault();
						const ids = draggedAssetIds(readLibraryDrag(event.dataTransfer) ?? null);
						endLibraryDrag();
						addFiles(ids, documentPoint(event));
					}}>
					{!board.document && !board.error && <p className="canvas-empty" role="status">{t.common.loading}</p>}
					{board.document && nodes.length === 0 && <p className="canvas-empty">{t.canvas.empty}</p>}
					<div className="canvas-plane" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
						<CanvasConnections edges={board.document?.edges ?? []} nodes={visibleNodes} selected={edge?.id ?? null} selectedNodes={selected} draft={draft}
							onSelect={(item) => { setEdgeId(item.id); setSelected(new Set()); setConnection(null); setEditing(null); }} />
						{visibleNodes.map((node) => (
							<CanvasCard key={node.id} node={node} selected={selected.has(node.id)} editing={editing === node.id}
								showPorts={single?.id === node.id && !editing && !pan && !shift}
								connectSide={connection?.id === node.id ? connection.side : undefined}
								connecting={Boolean(connection)}
								asset={assetForNode(node)}
								assets={assets}
								style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.width, height: node.height }}
								onMove={(event) => { if (!event.defaultPrevented) dragNode(event, node, false); }}
								onResize={(event) => { if (!event.defaultPrevented) dragNode(event, node, true); }}
								onSelect={selectNode} onNudge={(event, id, resize) => {
									const step = ARROW_STEPS[event.key];
									if (!step || isImeComposing(event.nativeEvent)) return;
									event.preventDefault();
									const ids = !resize && selected.has(id) ? selected : new Set([id]);
									setSelected(ids);
									setEdgeId(null);
									setConnection(null);
									const distance = event.shiftKey ? 32 : 8;
									const ratio = resize ? mediaRatioForNode(node) : undefined;
									const direction = step.x || step.y;
									const delta = ratio
										? { x: direction * distance * Math.min(1, ratio), y: direction * distance * Math.min(1, 1 / ratio) }
										: { x: step.x * distance, y: step.y * distance };
									transform(resize ? ids : movingCards(layoutNodes, ids), delta, resize, ratio);
								}}
								onEdit={editCard} onBlur={board.endGroup}
								onText={(id, key, value) => patchNode(id, (current) => ({ ...current, [key]: value }), id)}
								onPreview={onPreview} onMediaLoad={recordMediaSize} onRelink={(id) => setFileSearch({ replaceId: id })}
								onConnect={startConnection} onConnectDrag={dragConnection} />
						))}
						{box && <div className="canvas-marquee" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
					</div>
				</div>
				<div className="canvas-notices">
					{connection && <span className="canvas-status" role="status">{t.canvas.connectTarget}</span>}
					{board.saving && !board.error && <span className="canvas-status" role="status">{t.canvas.saving}</span>}
				</div>
				<CanvasToolbar className="canvas-history" label={t.canvas.historyTools}>
					<CanvasAction icon="undo" label={t.canvas.undo} disabled={!board.canUndo} onClick={board.undo} />
					<CanvasAction icon="redo" label={t.canvas.redo} disabled={!board.canRedo} onClick={board.redo} />
				</CanvasToolbar>
				{anchor && !shift && !box && !draft && <CanvasSelectionControls anchor={{
					x: view.x + anchor.x * view.scale, y: view.y + (anchor.y - anchorTopInset) * view.scale,
					width: anchor.width * view.scale, height: (anchor.height + anchorTopInset) * view.scale,
				}}>
					{edge && <input key={edge.id} className="canvas-edge-input" aria-label={t.canvas.edgeLabel} placeholder={t.canvas.edgeLabel}
						value={edge.label ?? ""} onBlur={board.endGroup}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || event.key !== "Enter") return;
							event.preventDefault();
							surface.current?.focus({ preventScroll: true });
						}}
						onChange={(event) => {
							const current = board.live.current?.document;
							if (current) board.commit({ ...current, edges: current.edges.map((item) => item.id === edge.id ? { ...item, label: event.target.value } : item) }, edge.id);
						}} />}
					<CanvasToolbar className="canvas-selection-tools" label={t.canvas.selectionTools}>
						{canEdit && <CanvasAction icon={isEditing ? "done" : "edit"} label={isEditing ? t.canvas.done : t.common.edit}
							showLabel onClick={() => editCard(isEditing ? null : single.id)} />}
						{preview && <CanvasAction icon="open" label={t.canvas.openCard} showLabel onClick={() => onPreview(preview)} />}
						{!isEditing && (single || selectedNodes.length === 2) && <CanvasAction icon="connect" label={t.canvas.connect}
							showLabel pressed={single ? Boolean(connection) : undefined}
							onClick={() => single ? startConnection(single.id) : addEdge(selectedNodes[0], selectedNodes[1])} />}
						<CanvasAction icon="remove" label={t.canvas.deleteSelected} onClick={removeSelection} />
					</CanvasToolbar>
				</CanvasSelectionControls>}
				<div className="canvas-docks" ref={docks}>
					<CanvasToolbar className="canvas-create" label={t.canvas.createTools}>
						<CanvasAction icon="text" label={t.canvas.addNote} showLabel disabled={!board.document} onClick={() => addTextCard()} />
						<CanvasAction icon="document" label={t.canvas.addFiles} showLabel disabled={!board.document} onClick={() => setFileSearch({ point: centerPoint() })} />
					</CanvasToolbar>
					<CanvasToolbar className="canvas-view" label={t.canvas.viewTools}>
						<CanvasAction icon="pan" label={t.canvas.pan} pressed={pan} onClick={() => { setPan(!pan); setConnection(null); }} />
						<span className="canvas-toolbar-divider" role="separator" aria-orientation="vertical" />
						<CanvasAction icon="minus" label={t.canvas.zoomOut} onClick={() => zoom(1 / 1.25)} />
						<output className="canvas-zoom">{Math.round(view.scale * 100)}%</output>
						<CanvasAction icon="plus" label={t.canvas.zoomIn} onClick={() => zoom(1.25)} />
						<CanvasAction icon="fit" label={t.canvas.fit} onClick={fit} />
					</CanvasToolbar>
				</div>
			</div>
			{fileSearch && <LibraryFileSearch assets={searchableFiles}
				title={"point" in fileSearch ? t.canvas.addFiles : t.canvas.relink}
				onClose={finishFileSearch} />}
		</section>
	);
}
