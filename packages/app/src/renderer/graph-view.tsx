import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, AssetRelation, AssetType } from "@loom/core";
import {
	GRAPH_NODE_RADIUS,
	GRAPH_SELECTED_RADIUS,
	graphBounds,
	layoutForceGraph,
} from "./graph-layout.ts";

interface GraphViewProps {
	assets: Asset[];
	edges: AssetRelation[];
	selectedAssetId: string | null;
	onSelectAsset: (assetId: string) => void;
}

interface Viewport {
	x: number;
	y: number;
	scale: number;
}

const TYPE_COLOR: Record<AssetType, string> = {
	image: "#6d84b4",
	video: "#8a6d9e",
	audio: "#5d8a7a",
	text: "#9a7b4f",
	other: "#8b8e93",
};

export function GraphView({
	assets,
	edges,
	selectedAssetId,
	onSelectAsset,
}: GraphViewProps): React.JSX.Element {
	const canvasRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{ x: number; y: number; view: Viewport } | null>(null);
	const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });

	const visibleEdges = useMemo(() => {
		const ids = new Set(assets.map((asset) => asset.assetId));
		return edges.filter((edge) => ids.has(edge.fromAssetId) && ids.has(edge.toAssetId));
	}, [assets, edges]);

	const layout = useMemo(
		() => layoutForceGraph(
			assets.map((asset) => asset.assetId),
			visibleEdges.map((edge) => ({ fromId: edge.fromAssetId, toId: edge.toAssetId })),
		),
		[assets, visibleEdges],
	);
	const byId = useMemo(() => new Map(layout.map((node) => [node.id, node])), [layout]);
	const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.assetId, asset])), [assets]);

	useEffect(() => {
		const element = canvasRef.current;
		if (!element || layout.length === 0) return;
		const bounds = graphBounds(layout);
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
	}, [layout]);

	useEffect(() => {
		const element = canvasRef.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = element.getBoundingClientRect();
			const mx = event.clientX - rect.left;
			const my = event.clientY - rect.top;
			setViewport((current) => {
				const worldX = (mx - current.x) / current.scale;
				const worldY = (my - current.y) / current.scale;
				const scale = Math.min(4, Math.max(0.15, current.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
				return { scale, x: mx - worldX * scale, y: my - worldY * scale };
			});
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [assets.length]);

	if (assets.length === 0) {
		return (
			<div className="welcome">
				<h1>No assets yet</h1>
				<p>Open a library to see every asset and its relationships on one canvas.</p>
			</div>
		);
	}

	return (
		<div className="graph-view">
			<div className="graph-caption">
				{assets.length} assets · {visibleEdges.length} relations · scroll to zoom · drag to pan
			</div>
			<div
				ref={canvasRef}
				className="graph-canvas"
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					drag.current = { x: event.clientX, y: event.clientY, view: viewport };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const start = drag.current;
					if (!start) return;
					setViewport({
						...start.view,
						x: start.view.x + event.clientX - start.x,
						y: start.view.y + event.clientY - start.y,
					});
				}}
				onPointerUp={() => {
					drag.current = null;
				}}
			>
				<svg className="graph-world" role="img" aria-label="Asset relationship graph">
					<g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
						<defs>
							<marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
								<path d="M0,0 L8,4 L0,8 Z" fill="#9aa0a6" />
							</marker>
						</defs>
						{visibleEdges.map((edge) => {
							const from = byId.get(edge.fromAssetId);
							const to = byId.get(edge.toAssetId);
							if (!from || !to) return null;
							const start = edgePoint(from.x, from.y, to.x, to.y, GRAPH_NODE_RADIUS);
							const end = edgePoint(to.x, to.y, from.x, from.y, GRAPH_NODE_RADIUS + 6);
							return (
								<line
									key={edge.relationId}
									className="graph-edge"
									x1={start.x}
									y1={start.y}
									x2={end.x}
									y2={end.y}
									markerEnd="url(#graph-arrow)"
								>
									<title>{edge.type}</title>
								</line>
							);
						})}
						{layout.map((node) => {
							const asset = assetsById.get(node.id);
							if (!asset) return null;
							const selected = node.id === selectedAssetId;
							const radius = selected ? GRAPH_SELECTED_RADIUS : GRAPH_NODE_RADIUS;
							return (
								<g
									key={node.id}
									className={`graph-node${selected ? " selected" : ""}`}
									transform={`translate(${node.x} ${node.y})`}
									onPointerDown={(event) => event.stopPropagation()}
									onClick={() => onSelectAsset(node.id)}
								>
									<title>{asset.filename}</title>
									<circle r={radius} fill={TYPE_COLOR[asset.type]} />
									<text className="graph-node-name" y={radius + 14} textAnchor="middle">
										{truncate(asset.filename)}
									</text>
								</g>
							);
						})}
					</g>
				</svg>
			</div>
		</div>
	);
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
