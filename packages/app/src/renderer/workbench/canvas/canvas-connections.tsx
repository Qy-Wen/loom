import { useId } from "react";
import type { CanvasEdge, CanvasNode } from "../../../shared/canvas.ts";
import { useLocale } from "../../locale.tsx";
import { edgeCurve } from "./canvas-layout.ts";

export function CanvasConnections({ edges, nodes, selected, selectedNodes, draft, onSelect }: {
	edges: CanvasEdge[];
	nodes: CanvasNode[];
	selected: string | null;
	selectedNodes: ReadonlySet<string>;
	draft: string | null;
	onSelect: (edge: CanvasEdge) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const marker = useId();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const lines = edges.flatMap((edge) => {
		const from = byId.get(edge.fromNode), to = byId.get(edge.toNode);
		if (!from || !to) return [];
		return [{ edge, ...edgeCurve(edge, from, to) }];
	});
	return <>
		<svg className="canvas-lines" width="1" height="1" aria-hidden="true">
			<defs>
				<marker id={marker} markerWidth="7" markerHeight="8" refX="6.5" refY="4" orient="auto-start-reverse">
					<path d="M 1.5 1.5 L 6.5 4 L 1.5 6.5" fill="none" stroke="context-stroke" strokeLinejoin="round" strokeLinecap="round" />
				</marker>
			</defs>
			{lines.map(({ edge, path }) => (
				<path key={edge.id} className={selected === edge.id ? "selected"
					: selectedNodes.has(edge.fromNode) || selectedNodes.has(edge.toNode) ? "related" : undefined}
					d={path} fill="none"
					markerStart={edge.fromEnd === "arrow" ? `url(#${marker})` : undefined}
					markerEnd={edge.toEnd === "none" ? undefined : `url(#${marker})`} />
			))}
			{draft && <path className="selected" d={draft} fill="none" strokeDasharray="5 3" />}
		</svg>
		{lines.map(({ edge, midpoint }) => (
			<button key={edge.id} className={`canvas-edge-label${edge.label ? "" : " is-unlabeled"}`} type="button" data-edge-id={edge.id}
				style={{ left: midpoint.x, top: midpoint.y }}
				aria-label={edge.label || t.canvas.connection} aria-pressed={selected === edge.id}
				onClick={() => onSelect(edge)}>{edge.label || "↗"}</button>
		))}
	</>;
}
