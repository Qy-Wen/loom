import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Asset } from "@loom/core";
import { isCanvasLibraryPath, removeCanvasElements, type CanvasNode } from "../../../shared/canvas.ts";
import { draggedAssetIds, endLibraryDrag, hasLibraryDrag, readLibraryDrag } from "../../assets/asset-drag.ts";
import { useConfirmation } from "../../components/confirm-dialog.tsx";
import { isImeComposing } from "../../components/ime-composition.ts";
import { useLocale } from "../../locale.tsx";
import { rectBetween, rectsIntersect, type Rect } from "../browser/folder-browser-model.ts";
import { CanvasCard } from "./canvas-card.tsx";
import { CanvasConnections } from "./canvas-connections.tsx";
import { containsCard, fitNodes, movingCards, worldPoint, zoomAt, type Point, type Viewport } from "./canvas-layout.ts";
import { useCanvasDocument } from "./use-canvas-document.ts";
import { useCanvasDrag } from "./use-canvas-drag.ts";
import "./canvas.css";

const EMPTY_NODES: CanvasNode[] = [];
const ARROW_STEPS: Record<string, Point> = {
	ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
};

function reshape(node: CanvasNode, delta: Point, resize: boolean): CanvasNode {
	const x = Math.round(delta.x), y = Math.round(delta.y);
	if (!x && !y) return node;
	return resize
		? { ...node, width: Math.max(96, node.width + x), height: Math.max(72, node.height + y) }
		: { ...node, x: node.x + x, y: node.y + y };
}

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
	const capture = useCanvasDrag(surface);
	const [view, setView] = useState<Viewport>({ x: 36, y: 36, scale: 1 });
	const [pan, setPan] = useState(false);
	const space = useRef(false);
	const ready = useRef(false);
	const consumed = useRef<readonly string[] | undefined>(undefined);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [edgeId, setEdgeId] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [box, setBox] = useState<Rect | null>(null);
	const [shift, setShift] = useState<{ ids: ReadonlySet<string>; delta: Point; resize: boolean } | null>(null);
	const byId = useMemo(() => new Map(assets.map((file) => [file.assetId, file])), [assets]);
	const byPath = useMemo(() => new Map(assets.map((file) => [file.relativePath, file])), [assets]);
	const nodes = board.document?.nodes ?? EMPTY_NODES;
	const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
	const visibleNodes = shift ? nodes.map((node) => shift.ids.has(node.id) ? reshape(node, shift.delta, shift.resize) : node) : nodes;
	const selectedNodes = [...selected].filter((id) => nodeIds.has(id));
	const edge = board.document?.edges.find((item) => item.id === edgeId);

	function fit(): void {
		const element = surface.current;
		if (element) setView(fitNodes(board.live.current?.document.nodes ?? [], element.clientWidth, element.clientHeight));
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

	async function pickFiles(replaceId?: string): Promise<void> {
		try {
			const files = await window.loom.pickComposerLibraryAssets();
			if (!files.length || !board.live.current) return;
			if (replaceId) {
				const file = files[0];
				patchNode(replaceId, (node) => ({ ...node, file: file.path, loom: { ...node.loom, assetId: file.assetId } }));
			} else addFiles(files.map((file) => file.assetId), centerPoint());
		} catch (cause) {
			onError(String(cause));
		}
	}

	function addCard(type: "text" | "group"): void {
		const point = centerPoint();
		const id = crypto.randomUUID();
		const x = Math.round(point.x - 120), y = Math.round(point.y - 60);
		append([type === "text" ? { id, type, x, y, width: 260, height: 160, text: "" }
			: { id, type, x, y, width: 420, height: 280, label: t.canvas.group }], type === "group");
		setEditing(id);
	}

	function patchNode(id: string, patch: (node: CanvasNode) => CanvasNode, group?: string): void {
		const current = board.live.current?.document;
		if (current) board.commit({ ...current, nodes: current.nodes.map((node) => node.id === id ? patch(node) : node) }, group);
	}

	function selectNode(id: string, add: boolean): Set<string> {
		const next = add ? new Set(selected) : selected.has(id) ? selected : new Set<string>();
		if (add && next.has(id)) next.delete(id);
		else next.add(id);
		setSelected(next);
		setEdgeId(null);
		return next;
	}

	function transform(ids: ReadonlySet<string>, delta: Point, resize: boolean): void {
		if (Math.round(delta.x) === 0 && Math.round(delta.y) === 0) return;
		const current = board.live.current?.document;
		if (current) board.commit({ ...current, nodes: current.nodes.map((node) => ids.has(node.id) ? reshape(node, delta, resize) : node) });
	}

	function dragNode(event: PointerEvent, id: string, resize: boolean): void {
		if (event.button !== 0 || capture.drag.current) return;
		event.preventDefault();
		const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
		(target ?? event.currentTarget.querySelector<HTMLButtonElement>(".canvas-handle"))?.focus({ preventScroll: true });
		const picked = resize ? new Set([id]) : selectNode(id, event.shiftKey || event.metaKey || event.ctrlKey);
		if (!picked.has(id)) return;
		if (resize) { setSelected(picked); setEdgeId(null); }
		const ids = resize ? picked : movingCards(nodes, picked);
		const scale = (delta: Point) => ({ x: delta.x / view.scale, y: delta.y / view.scale });
		capture.begin(event, (delta) => setShift({ ids, delta: scale(delta), resize }), (delta) => {
			setShift(null);
			if (delta) transform(ids, scale(delta), resize);
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
		capture.begin(event, (delta) => setBox(rectangle(delta)), (delta) => {
			setBox(null);
			if (!delta) return;
			const area = rectangle(delta);
			const boxed = Math.hypot(delta.x, delta.y) < 4 ? [] : nodes
				.filter((node) => node.type === "group" ? containsCard(area, node) : rectsIntersect(area, node))
				.map((node) => node.id);
			setSelected(new Set([...base, ...boxed]));
		});
	}

	function addEdge(): void {
		const current = board.live.current?.document;
		if (!current || selectedNodes.length !== 2) return;
		const [fromNode, toNode] = selectedNodes;
		const id = crypto.randomUUID();
		board.commit({ ...current, edges: [...current.edges, { id, fromNode, toNode }] });
		setEdgeId(id);
		setSelected(new Set());
	}

	function removeSelection(): void {
		const current = board.live.current?.document;
		if (!current || (!selectedNodes.length && !edge)) return;
		board.commit(removeCanvasElements(current, new Set(selectedNodes), new Set(edge ? [edge.id] : [])));
		setSelected(new Set());
		setEdgeId(null);
	}

	function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
		const target = event.target;
		if (event.defaultPrevented || isImeComposing(event.nativeEvent)
			|| (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))) return;
		const mod = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) board.redo(); else board.undo(); }
		else if (mod && key === "y") { event.preventDefault(); board.redo(); }
		else if (mod && key === "a") { event.preventDefault(); setSelected(new Set(nodes.map((node) => node.id))); setEdgeId(null); }
		else if (key === "delete" || key === "backspace") { event.preventDefault(); removeSelection(); }
		else if (key === "escape") { setSelected(new Set()); setEdgeId(null); setEditing(null); }
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
			<div className="canvas-toolbar">
				<button type="button" disabled={!board.document} onClick={() => void pickFiles()}>{t.canvas.addFiles}</button>
				<button type="button" disabled={!board.document} onClick={() => addCard("text")}>{t.canvas.addNote}</button>
				<button type="button" disabled={!board.document} onClick={() => addCard("group")}>{t.canvas.addGroup}</button>
				<button type="button" disabled={selectedNodes.length !== 2} title={t.canvas.connectHint} onClick={addEdge}>{t.canvas.connect}</button>
				<button type="button" disabled={!selectedNodes.length && !edge} onClick={removeSelection}>{t.canvas.deleteSelected}</button>
				<div className="canvas-toolbar-divider" />
				<button type="button" disabled={!board.canUndo} aria-label={t.canvas.undo} title={t.canvas.undo} onClick={board.undo}>↶</button>
				<button type="button" disabled={!board.canRedo} aria-label={t.canvas.redo} title={t.canvas.redo} onClick={board.redo}>↷</button>
				<button type="button" aria-pressed={pan} onClick={() => setPan(!pan)}>{t.canvas.pan}</button>
				<button type="button" aria-label={t.canvas.zoomOut} title={t.canvas.zoomOut} onClick={() => zoom(1 / 1.25)}>−</button>
				<output className="canvas-zoom">{Math.round(view.scale * 100)}%</output>
				<button type="button" aria-label={t.canvas.zoomIn} title={t.canvas.zoomIn} onClick={() => zoom(1.25)}>+</button>
				<button type="button" onClick={fit}>{t.canvas.fit}</button>
				{edge && <input key={edge.id} aria-label={t.canvas.edgeLabel} placeholder={t.canvas.edgeLabel} value={edge.label ?? ""}
					onBlur={board.endGroup} onChange={(event) => {
						const current = board.live.current?.document;
						if (current) board.commit({ ...current, edges: current.edges.map((item) => item.id === edge.id ? { ...item, label: event.target.value } : item) }, edge.id);
					}} />}
				{board.saving && !board.error && <span className="canvas-status" role="status">{t.canvas.saving}</span>}
			</div>
			{board.error && <div className="canvas-save-error" role="alert">
				<span>{board.conflict ? t.canvas.conflict : board.error}</span>
				{board.saving && !board.conflict && <button type="button" onClick={board.retry}>{t.canvas.retry}</button>}
				<button type="button" onClick={() => void reload()}>{t.canvas.reload}</button>
			</div>}
			<div ref={surface} className={`canvas-surface${pan ? " pan" : ""}`} tabIndex={0} aria-label={t.canvas.canvas}
				onPointerDownCapture={(event) => { if (pan || space.current || event.button === 1) pointerDown(event); }}
				onPointerDown={(event) => { if (!event.defaultPrevented) pointerDown(event); }}
				onPointerMove={capture.move} onPointerUp={(event) => capture.end(event)}
				onPointerCancel={(event) => capture.end(event, true)}
				onPointerLeave={(event) => { if (!capture.drag.current?.started) capture.end(event, true); }}
				onLostPointerCapture={(event) => { if (event.target === event.currentTarget) capture.end(event, true); }}
				onKeyUp={(event) => { if (event.key === " ") space.current = false; }}
				onBlur={() => { space.current = false; }}
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
					<CanvasConnections edges={board.document?.edges ?? []} nodes={visibleNodes} selected={edge?.id ?? null}
						onSelect={(item) => { setEdgeId(item.id); setSelected(new Set()); }} />
					{visibleNodes.map((node) => (
						<CanvasCard key={node.id} node={node} selected={selected.has(node.id)} editing={editing === node.id}
							asset={node.loom?.assetId ? byId.get(node.loom.assetId) : node.file ? byPath.get(node.file) : undefined}
							assets={assets}
							style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.width, height: node.height }}
							onMove={(event, id) => { if (!event.defaultPrevented) dragNode(event, id, false); }}
							onResize={(event, id) => { if (!event.defaultPrevented) dragNode(event, id, true); }}
							onSelect={selectNode} onNudge={(event, id, resize) => {
								const step = ARROW_STEPS[event.key];
								if (!step || isImeComposing(event.nativeEvent)) return;
								event.preventDefault();
								const ids = !resize && selected.has(id) ? selected : new Set([id]);
								setSelected(ids);
								setEdgeId(null);
								const distance = event.shiftKey ? 32 : 8;
								transform(resize ? ids : movingCards(nodes, ids), { x: step.x * distance, y: step.y * distance }, resize);
							}}
							onEdit={setEditing} onBlur={board.endGroup}
							onText={(id, key, value) => patchNode(id, (current) => ({ ...current, [key]: value }), id)}
							onPreview={onPreview} onRelink={(id) => void pickFiles(id)} />
					))}
					{box && <div className="canvas-marquee" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
				</div>
			</div>
		</section>
	);
}
