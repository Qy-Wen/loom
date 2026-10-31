import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Asset, AssetRelation, AssetType } from "@loom/core";
import {
	GRAPH_NODE_RADIUS,
	GRAPH_PLUS_OFFSET,
	GRAPH_SELECTED_RADIUS,
	GRAPH_SNAP_PAD,
	graphBounds,
	nearestNode,
	nodeHitZone,
	nodesInRect,
	rectBetween,
} from "./graph-layout.ts";
import { assetTypeLabel, uiPlatform } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { SuggestInput } from "../components/suggest-input.tsx";
import { pointerMode } from "../library/tree-nav.ts";
import { wheelZoomFactor } from "./media-zoom.ts";
import { useGraphSimulation } from "./graph-simulation.ts";
import { GraphHelp } from "./graph-help.tsx";

interface GraphViewProps {
	assets: Asset[];
	edges: AssetRelation[];
	selectedAssetIds: ReadonlySet<string>;
	relationTypes: string[];
	onSelectAsset: (assetId: string) => void;
	/** Files inside a box drag, or none for a click on empty canvas. `add` keeps the current selection. */
	onBoxSelect: (assetIds: string[], add: boolean) => void;
	onCreateRelation: (fromAssetId: string, toAssetId: string, type: string) => Promise<void>;
	onRemoveRelation: (relationId: string) => Promise<void>;
}

interface Viewport {
	x: number;
	y: number;
	scale: number;
}

interface PendingLink {
	fromId: string;
	toId: string;
}

interface HoverState {
	id: string;
	angle: number;
	zone: "body" | "rim";
}

type PointerDrag =
	| { kind: "pan"; x: number; y: number; pointerId: number }
	| { kind: "box"; x: number; y: number; add: boolean; started: boolean }
	| { kind: "move"; id: string; x: number; y: number; started: boolean }
	| { kind: "link"; fromId: string };

const TYPE_COLOR: Record<AssetType, string> = {
	image: "var(--lm-asset-image)",
	video: "var(--lm-asset-video)",
	audio: "var(--lm-asset-audio)",
	text: "var(--lm-asset-text)",
	other: "var(--lm-asset-other)",
};

const TYPE_ORDER: AssetType[] = ["image", "video", "audio", "text", "other"];

const MOVE_THRESHOLD = 6;
const PARALLEL_GAP = 12;
const PLUS_RADIUS = 8;
const PLUS_ARM = 3.5;

export function GraphView({
	assets,
	edges,
	selectedAssetIds,
	relationTypes,
	onSelectAsset,
	onBoxSelect,
	onCreateRelation,
	onRemoveRelation,
}: GraphViewProps): React.JSX.Element {
	const { t } = useLocale();
	const canvasRef = useRef<HTMLDivElement>(null);
	const drag = useRef<PointerDrag | null>(null);
	const fitted = useRef(false);
	const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const [linkPreview, setLinkPreview] = useState<{ x: number; y: number } | null>(null);
	const [linkTargetId, setLinkTargetId] = useState<string | null>(null);
	const [hover, setHover] = useState<HoverState | null>(null);
	const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
	const linkDialogRef = useRef<HTMLDivElement>(null);
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
	const [typeDraft, setTypeDraft] = useState("");
	const [typeOpen, setTypeOpen] = useState(false);
	const [typeError, setTypeError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [activeDrag, setActiveDrag] = useState<"pan" | "move" | "link" | null>(null);
	// The box being dragged, in world coordinates so scrolling the canvas mid-drag does not move its corners.
	const [box, setBox] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);

	const visibleEdges = useMemo(() => {
		const ids = new Set(assets.map((asset) => asset.assetId));
		return edges.filter((edge) => ids.has(edge.fromAssetId) && ids.has(edge.toAssetId));
	}, [assets, edges]);
	const { nodes, pin, unpin } = useGraphSimulation(
		assets.map((asset) => asset.assetId),
		visibleEdges.map((edge) => ({ fromId: edge.fromAssetId, toId: edge.toAssetId })),
	);
	const live = useRef({
		nodes,
		pin,
		unpin,
		onSelectAsset,
		onBoxSelect,
	});
	live.current = { nodes, pin, unpin, onSelectAsset, onBoxSelect };
	const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
	const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.assetId, asset])), [assets]);
	const parallelIndex = useMemo(() => indexParallelEdges(visibleEdges), [visibleEdges]);
	const legendTypes = useMemo(
		() => TYPE_ORDER.filter((type) => assets.some((asset) => asset.type === type)),
		[assets],
	);

	useLayoutEffect(() => {
		const element = canvasRef.current;
		if (!element || nodes.length === 0 || fitted.current) return;
		const bounds = graphBounds(nodes);
		const scale = Math.min(
			element.clientWidth / bounds.width,
			element.clientHeight / bounds.height,
			1.6,
		);
		setViewport({
			scale,
			x: element.clientWidth / 2 - (bounds.minX + bounds.width / 2) * scale,
			y: element.clientHeight / 2 - (bounds.minY + bounds.height / 2) * scale,
		});
		fitted.current = true;
	}, [nodes]);

	useEffect(() => {
		if (assets.length === 0) fitted.current = false;
	}, [assets.length]);

	useEffect(() => {
		const element = canvasRef.current;
		if (!element) return;
		const platform = uiPlatform(navigator.userAgent);
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			// Two-finger drag / scroll pans. Pinch (reported as ctrl+wheel) and Ctrl/Cmd+wheel zoom.
			if (!event.ctrlKey && !event.metaKey) {
				setViewport((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
				return;
			}
			const rect = element.getBoundingClientRect();
			const mx = event.clientX - rect.left;
			const my = event.clientY - rect.top;
			setViewport((current) => {
				const worldX = (mx - current.x) / current.scale;
				const worldY = (my - current.y) / current.scale;
				const scale = Math.min(4, Math.max(0.15, current.scale * wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey, platform)));
				return { scale, x: mx - worldX * scale, y: my - worldY * scale };
			});
		};
		const onSelectStart = (event: Event) => event.preventDefault();
		element.addEventListener("wheel", onWheel, { passive: false });
		element.addEventListener("selectstart", onSelectStart);
		return () => {
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("selectstart", onSelectStart);
		};
	}, [assets.length]);

	useEffect(() => {
		if (selectedEdgeId && !edges.some((edge) => edge.relationId === selectedEdgeId)) {
			setSelectedEdgeId(null);
		}
	}, [edges, selectedEdgeId]);

	useEffect(() => {
		const toWorld = (clientX: number, clientY: number) => {
			const element = canvasRef.current;
			const view = viewportRef.current;
			if (!element) return { x: 0, y: 0 };
			const rect = element.getBoundingClientRect();
			return {
				x: (clientX - rect.left - view.x) / view.scale,
				y: (clientY - rect.top - view.y) / view.scale,
			};
		};
		const snap = (world: { x: number; y: number }, fromId: string) => (
			nearestNode(
				live.current.nodes,
				world.x,
				world.y,
				fromId,
				GRAPH_SELECTED_RADIUS + GRAPH_SNAP_PAD,
			)?.id ?? null
		);
		const onMove = (event: PointerEvent) => {
			const start = drag.current;
			if (!start) return;
			if (start.kind === "pan") {
				if (event.pointerId !== start.pointerId) return;
				const dx = event.clientX - start.x;
				const dy = event.clientY - start.y;
				start.x = event.clientX;
				start.y = event.clientY;
				setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
				return;
			}
			const world = toWorld(event.clientX, event.clientY);
			if (start.kind === "box") {
				if (!start.started && Math.hypot(event.clientX - start.x, event.clientY - start.y) < MOVE_THRESHOLD) return;
				const origin = toWorld(start.x, start.y);
				start.started = true;
				setHover(null);
				setBox({ from: origin, to: world });
				return;
			}
			if (start.kind === "move") {
				if (!start.started && Math.hypot(event.clientX - start.x, event.clientY - start.y) < MOVE_THRESHOLD) {
					return;
				}
				start.started = true;
				setActiveDrag("move");
				setHover(null);
				live.current.pin(start.id, world.x, world.y);
				return;
			}
			setActiveDrag("link");
			setLinkPreview(world);
			setLinkTargetId(snap(world, start.fromId));
		};
		const onUp = (event: PointerEvent) => {
			const start = drag.current;
			if (!start) return;
			if (start.kind === "pan" && (event.pointerId !== start.pointerId || event.button !== 1)) return;
			drag.current = null;
			setActiveDrag(null);
			if (start.kind === "pan") return;
			if (start.kind === "box") {
				setBox(null);
				setSelectedEdgeId(null);
				const ids = start.started
					? nodesInRect(live.current.nodes, rectBetween(toWorld(start.x, start.y), toWorld(event.clientX, event.clientY)))
					: [];
				live.current.onBoxSelect(ids, start.add);
				return;
			}
			if (start.kind === "move") {
				if (start.started) live.current.unpin(start.id);
				else {
					setSelectedEdgeId(null);
					live.current.onSelectAsset(start.id);
				}
				return;
			}
			const targetId = snap(toWorld(event.clientX, event.clientY), start.fromId);
			setLinkPreview(null);
			setLinkTargetId(null);
			setHover(null);
			if (!targetId) return;
			setPendingLink({ fromId: start.fromId, toId: targetId });
			setTypeDraft("");
			setTypeOpen(false);
			setTypeError(null);
		};
		const onCancel = () => {
			const start = drag.current;
			drag.current = null;
			setActiveDrag(null);
			setBox(null);
			setLinkPreview(null);
			setLinkTargetId(null);
			if (start?.kind === "move" && start.started) live.current.unpin(start.id);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onCancel);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onCancel);
		};
	}, []);

	// A press anywhere outside the dialog dismisses it. Not while the relation is being saved, so an error is not lost.
	useEffect(() => {
		if (!pendingLink || saving) return;
		const onPointerDown = (event: PointerEvent) => {
			if (linkDialogRef.current?.contains(event.target as Node)) return;
			setPendingLink(null);
			setTypeError(null);
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [pendingLink, saving]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && pendingLink) {
				setPendingLink(null);
				setTypeError(null);
				return;
			}
			if (pendingLink || (event.key !== "Delete" && event.key !== "Backspace")) return;
			if (isTextInput(event.target) || !selectedEdgeId) return;
			event.preventDefault();
			void onRemoveRelation(selectedEdgeId).then(() => setSelectedEdgeId(null));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onRemoveRelation, pendingLink, selectedEdgeId]);

	function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
		const element = canvasRef.current;
		const view = viewportRef.current;
		if (!element) return { x: 0, y: 0 };
		const rect = element.getBoundingClientRect();
		return {
			x: (clientX - rect.left - view.x) / view.scale,
			y: (clientY - rect.top - view.y) / view.scale,
		};
	}

	function radiusOf(id: string): number {
		return selectedAssetIds.has(id) ? GRAPH_SELECTED_RADIUS : GRAPH_NODE_RADIUS;
	}

	function hoverAt(world: { x: number; y: number }): HoverState | null {
		let best: HoverState | null = null;
		let bestDist = Infinity;
		for (const node of nodes) {
			const dist = Math.hypot(world.x - node.x, world.y - node.y);
			const zone = nodeHitZone(dist, radiusOf(node.id));
			if (zone === "none" || dist >= bestDist) continue;
			best = { id: node.id, angle: Math.atan2(world.y - node.y, world.x - node.x), zone };
			bestDist = dist;
		}
		return best;
	}

	async function confirmLink(): Promise<void> {
		if (!pendingLink || !typeDraft.trim() || saving) return;
		setSaving(true);
		setTypeError(null);
		try {
			await onCreateRelation(pendingLink.fromId, pendingLink.toId, typeDraft);
			setPendingLink(null);
			setTypeDraft("");
		} catch (cause) {
			setTypeError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	if (assets.length === 0) {
		return (
			<div className="welcome">
				<h1>{t.graph.emptyTitle}</h1>
				<p>{t.graph.emptyBody}</p>
			</div>
		);
	}

	const selectedEdge = visibleEdges.find((edge) => edge.relationId === selectedEdgeId);
	const linking = activeDrag === "link";
	const moving = activeDrag === "move";
	const panning = activeDrag === "pan";
	const plusNode = !linking && !moving && hover?.zone === "rim" ? byId.get(hover.id) : undefined;
	const plusPos = plusNode && hover
		? {
			x: plusNode.x + Math.cos(hover.angle) * (radiusOf(hover.id) + GRAPH_PLUS_OFFSET),
			y: plusNode.y + Math.sin(hover.angle) * (radiusOf(hover.id) + GRAPH_PLUS_OFFSET),
		}
		: null;
	const previewFrom = linking && drag.current?.kind === "link" ? byId.get(drag.current.fromId) : undefined;
	const previewTo = linkTargetId ? byId.get(linkTargetId) : undefined;
	const previewEnd = previewTo
		? edgePoint(previewTo.x, previewTo.y, previewFrom?.x ?? previewTo.x, previewFrom?.y ?? previewTo.y, radiusOf(previewTo.id))
		: linkPreview;

	return (
		<div className="graph-view">
			<div className="graph-caption">
				<div className="graph-caption-summary">
					<span>{t.graph.caption(assets.length, visibleEdges.length)}</span>
					<GraphHelp />
				</div>
				{selectedEdge && (
					<button
						className="text-button"
						type="button"
						onClick={() => void onRemoveRelation(selectedEdge.relationId).then(() => setSelectedEdgeId(null))}
					>
						Remove {selectedEdge.type}
					</button>
				)}
			</div>
			<div
				ref={canvasRef}
				className={`graph-canvas${linking ? " linking" : ""}${moving ? " moving" : ""}${panning ? " panning" : ""}`}
				onPointerDownCapture={(event) => {
					if (event.button !== 1 || pendingLink || drag.current) return;
					event.preventDefault();
					event.stopPropagation();
					drag.current = { kind: "pan", x: event.clientX, y: event.clientY, pointerId: event.pointerId };
					setActiveDrag("pan");
					setHover(null);
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}
				onPointerDown={(event) => {
					if (event.button !== 0 || pendingLink) return;
					window.getSelection()?.removeAllRanges();
					// Left-drag on empty canvas selects; middle-drag and scrolling pan.
					const add = pointerMode(event, uiPlatform(navigator.userAgent) === "mac") !== "replace";
					drag.current = { kind: "box", x: event.clientX, y: event.clientY, add, started: false };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					if (!drag.current) setHover(hoverAt(screenToWorld(event.clientX, event.clientY)));
				}}
			>
				<svg className="graph-world" role="img" aria-label={t.graph.canvas}>
					<g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
						<defs>
							<marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
								<path d="M0,0 L8,4 L0,8 Z" style={{ fill: "var(--lm-text-faint)" }} />
							</marker>
							<marker id="graph-arrow-selected" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
								<path d="M0,0 L8,4 L0,8 Z" style={{ fill: "var(--lm-text-primary)" }} />
							</marker>
						</defs>
						{visibleEdges.map((edge) => {
							const from = byId.get(edge.fromAssetId);
							const to = byId.get(edge.toAssetId);
							if (!from || !to) return null;
							const shifted = offsetPair(from, to, parallelIndex.get(edge.relationId) ?? 0);
							const start = edgePoint(shifted.from.x, shifted.from.y, shifted.to.x, shifted.to.y, GRAPH_NODE_RADIUS);
							const end = edgePoint(shifted.to.x, shifted.to.y, shifted.from.x, shifted.from.y, GRAPH_NODE_RADIUS + 6);
							const selected = edge.relationId === selectedEdgeId;
							const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
							return (
								<g
									key={edge.relationId}
									className={`graph-edge-group${selected ? " selected" : ""}`}
									onPointerDown={(event) => {
										event.stopPropagation();
										setSelectedEdgeId(edge.relationId);
									}}
								>
									<line className="graph-edge-hit" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
									<line
										className="graph-edge"
										x1={start.x}
										y1={start.y}
										x2={end.x}
										y2={end.y}
										markerEnd={selected ? "url(#graph-arrow-selected)" : "url(#graph-arrow)"}
									>
										<title>{edge.type}</title>
									</line>
									<text className="graph-edge-label" x={mid.x} y={mid.y - 4} textAnchor="middle">
										{edge.type}
									</text>
								</g>
							);
						})}
						{box && (
							<rect
								className="graph-box"
								x={Math.min(box.from.x, box.to.x)}
								y={Math.min(box.from.y, box.to.y)}
								width={Math.abs(box.to.x - box.from.x)}
								height={Math.abs(box.to.y - box.from.y)}
							/>
						)}
						{previewFrom && previewEnd && (
							<line
								className={`graph-link-preview${previewTo ? " snapping" : ""}`}
								x1={previewFrom.x}
								y1={previewFrom.y}
								x2={previewEnd.x}
								y2={previewEnd.y}
							/>
						)}
						{nodes.map((node) => {
							const asset = assetsById.get(node.id);
							if (!asset) return null;
							const selected = selectedAssetIds.has(node.id);
							const radius = selected ? GRAPH_SELECTED_RADIUS : GRAPH_NODE_RADIUS;
							const dropTarget = node.id === linkTargetId;
							return (
								<g
									key={node.id}
									className={`graph-node${selected ? " selected" : ""}${dropTarget ? " drop-target" : ""}${hover?.id === node.id && !linking && !moving ? " hovered" : ""}`}
									data-asset-id={node.id}
									transform={`translate(${node.x} ${node.y})`}
									onPointerDown={(event) => {
										if (event.button !== 0 || pendingLink) return;
										event.stopPropagation();
										window.getSelection()?.removeAllRanges();
										const world = screenToWorld(event.clientX, event.clientY);
										const zone = nodeHitZone(
											Math.hypot(world.x - node.x, world.y - node.y),
											radius,
										);
										if (zone === "rim") {
											drag.current = { kind: "link", fromId: node.id };
											setActiveDrag("link");
											setLinkPreview(world);
											setLinkTargetId(null);
											setHover(null);
										} else {
											drag.current = {
												kind: "move",
												id: node.id,
												x: event.clientX,
												y: event.clientY,
												started: false,
											};
										}
										event.currentTarget.setPointerCapture(event.pointerId);
									}}
								>
									<title>{asset.filename}</title>
									<circle r={radius} fill={TYPE_COLOR[asset.type]} />
									<text className="graph-node-name" y={radius + 14} textAnchor="middle">
										{truncate(asset.filename)}
									</text>
								</g>
							);
						})}
						{plusPos && (
							<g
								className="graph-plus"
								transform={`translate(${plusPos.x} ${plusPos.y})`}
								onPointerDown={(event) => {
									if (event.button !== 0 || !hover || pendingLink) return;
									event.stopPropagation();
									window.getSelection()?.removeAllRanges();
									drag.current = { kind: "link", fromId: hover.id };
									setActiveDrag("link");
									setLinkPreview(screenToWorld(event.clientX, event.clientY));
									setLinkTargetId(null);
									setHover(null);
									event.currentTarget.setPointerCapture(event.pointerId);
								}}
							>
								<circle r={PLUS_RADIUS} />
								{/* Two strokes, not a "+" glyph: a glyph sits at a different height in each font, a stroke is centred by geometry. */}
								<path className="graph-plus-mark" d={`M${-PLUS_ARM} 0H${PLUS_ARM}M0 ${-PLUS_ARM}V${PLUS_ARM}`} />
							</g>
						)}
					</g>
				</svg>
				{legendTypes.length > 0 && (
					<ul className="graph-legend" aria-label={t.graph.types}>
						{legendTypes.map((type) => (
							<li key={type}>
								<span className="graph-legend-swatch" style={{ background: TYPE_COLOR[type] }} />
								{assetTypeLabel(t, type)}
							</li>
						))}
					</ul>
				)}
			</div>
			{pendingLink && (
				<div
					ref={linkDialogRef}
					className="graph-type-dialog"
					role="dialog"
					aria-label={t.graph.createRelation}
					onKeyDown={(event) => {
						if (event.key === "Enter") void confirmLink();
					}}
				>
					<div className="graph-type-dialog-title">
						{t.graph.relate(
							assetsById.get(pendingLink.fromId)?.filename ?? t.graph.asset,
							assetsById.get(pendingLink.toId)?.filename ?? t.graph.asset,
						)}
					</div>
					<SuggestInput
						autoFocus
						value={typeDraft}
						open={typeOpen}
						suggestions={relationTypes}
						placeholder={t.graph.relationshipType}
						showLabel={t.graph.showTypes}
						hideLabel={t.graph.hideTypes}
						onChange={setTypeDraft}
						onOpenChange={setTypeOpen}
					/>
					{typeError && <div className="graph-type-error">{typeError}</div>}
					<div className="property-form-actions">
						<button type="button" onClick={() => { setPendingLink(null); setTypeError(null); }}>
							{t.common.cancel}
						</button>
						<button type="button" disabled={!typeDraft.trim() || saving} onClick={() => void confirmLink()}>
							{saving ? t.graph.creating : t.graph.create}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function indexParallelEdges(edges: AssetRelation[]): Map<string, number> {
	const groups = new Map<string, AssetRelation[]>();
	for (const edge of edges) {
		const key = pairKey(edge.fromAssetId, edge.toAssetId);
		const list = groups.get(key) ?? [];
		list.push(edge);
		groups.set(key, list);
	}
	const offsets = new Map<string, number>();
	for (const group of groups.values()) {
		group.forEach((edge, index) => {
			offsets.set(edge.relationId, (index - (group.length - 1) / 2) * PARALLEL_GAP);
		});
	}
	return offsets;
}

function pairKey(fromId: string, toId: string): string {
	return fromId < toId ? `${fromId}\0${toId}` : `${toId}\0${fromId}`;
}

function offsetPair(
	from: { x: number; y: number },
	to: { x: number; y: number },
	offset: number,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
	if (!offset) return { from, to };
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy) || 1;
	const ox = (-dy / dist) * offset;
	const oy = (dx / dist) * offset;
	return {
		from: { x: from.x + ox, y: from.y + oy },
		to: { x: to.x + ox, y: to.y + oy },
	};
}

function edgePoint(x: number, y: number, towardX: number, towardY: number, radius: number): { x: number; y: number } {
	const dx = towardX - x;
	const dy = towardY - y;
	const dist = Math.hypot(dx, dy) || 1;
	return { x: x + (dx / dist) * radius, y: y + (dy / dist) * radius };
}

function truncate(filename: string): string {
	return filename.length > 22 ? `${filename.slice(0, 21)}…` : filename;
}

function isTextInput(target: EventTarget | null): boolean {
	return target instanceof HTMLInputElement
		|| target instanceof HTMLTextAreaElement
		|| target instanceof HTMLSelectElement;
}
