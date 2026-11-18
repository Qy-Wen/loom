import { useId } from "react";
import type { CanvasEdge, CanvasNode } from "../../../shared/canvas.ts";
import { useLocale } from "../../locale.tsx";
import { edgePoint, facingSide } from "./canvas-layout.ts";

export function CanvasConnections({ edges, nodes, selected, onSelect }: {
	edges: CanvasEdge[];
	nodes: CanvasNode[];
	selected: string | null;
	onSelect: (edge: CanvasEdge) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const marker = useId();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const lines = edges.flatMap((edge) => {
		const from = byId.get(edge.fromNode), to = byId.get(edge.toNode);
		if (!from || !to) return [];
		const a = edgePoint(from, edge.fromSide ?? facingSide(from, to));
		const b = edgePoint(to, edge.toSide ?? facingSide(to, from));
		return [{ edge, a, b }];
	});
	return <>
		<svg className="canvas-lines" width="1" height="1" aria-hidden="true">
			<defs>
				<marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse">
					<path d="M 0 0 L 8 4 L 0 8 Z" fill="context-stroke" />
				</marker>
			</defs>
			{lines.map(({ edge, a, b }) => (
				<line key={edge.id} className={selected === edge.id ? "selected" : undefined}
					x1={a.x} y1={a.y} x2={b.x} y2={b.y}
					markerStart={edge.fromEnd === "arrow" ? `url(#${marker})` : undefined}
					markerEnd={edge.toEnd === "none" ? undefined : `url(#${marker})`} />
			))}
		</svg>
		{lines.map(({ edge, a, b }) => (
			<button key={edge.id} className="canvas-edge-label" type="button" data-edge-id={edge.id}
				style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }}
				aria-label={edge.label || t.canvas.connection} aria-pressed={selected === edge.id}
				onClick={() => onSelect(edge)}>{edge.label || "↗"}</button>
		))}
	</>;
}
