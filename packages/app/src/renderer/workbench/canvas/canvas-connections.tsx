import { useId, useState } from "react";
import type { CanvasEdge, CanvasNode } from "../../../shared/canvas.ts";
import { isImeComposing } from "../../components/ime-composition.ts";
import { useLocale } from "../../locale.tsx";
import { CanvasAction, CanvasToolbar } from "./canvas-controls.tsx";
import { edgeCurve, type Point } from "./canvas-layout.ts";

export type CanvasConnectionDraft = { path: string; target?: Point };
export const CANVAS_EDGE_LABEL_HEIGHT = 28;

export function CanvasConnections({ edges, nodes, selected, selectedNodes, draft, onSelect }: {
	edges: CanvasEdge[];
	nodes: CanvasNode[];
	selected: string | null;
	selectedNodes: ReadonlySet<string>;
	draft: CanvasConnectionDraft | null;
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
				<marker id={marker} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto-start-reverse">
					<path d="M 0.75 0.75 L 9 4 L 0.75 7.25 Z" fill="context-stroke" />
				</marker>
			</defs>
			{lines.map(({ edge, path }) => (
				<g key={edge.id}>
					<path className={`canvas-edge${selected === edge.id ? " selected"
						: selectedNodes.has(edge.fromNode) || selectedNodes.has(edge.toNode) ? " related" : ""}`}
					d={path} fill="none"
					markerStart={edge.fromEnd === "arrow" ? `url(#${marker})` : undefined}
					markerEnd={edge.toEnd === "none" ? undefined : `url(#${marker})`} />
					<path className="canvas-edge-hit" d={path} fill="none" onClick={() => onSelect(edge)} />
				</g>
			))}
			{draft && <path className="canvas-edge selected canvas-connection-preview" d={draft.path} fill="none"
				strokeDasharray={draft.target ? undefined : "5 3"} />}
		</svg>
		{draft?.target && <span className="canvas-connection-target" aria-hidden="true"
			style={{ left: draft.target.x, top: draft.target.y }} />}
			{lines.map(({ edge, midpoint }) => {
				const label = edge.label?.trim() ? edge.label : undefined;
				return <button key={edge.id} className={`canvas-edge-label${label ? "" : " is-unlabeled"}`} type="button" data-edge-id={edge.id}
					style={{ left: midpoint.x, top: midpoint.y, height: CANVAS_EDGE_LABEL_HEIGHT }}
					aria-pressed={selected === edge.id} onClick={() => onSelect(edge)}>{label ?? t.canvas.connection}</button>;
			})}
	</>;
}

export function CanvasEdgeActions({ label, onLabelChange, onLabelBlur, onFinish, onDelete }: {
	label: string;
	onLabelChange: (label: string) => void;
	onLabelBlur: () => void;
	onFinish: () => void;
	onDelete: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const [editing, setEditing] = useState(false);
	if (editing) return <input className="canvas-edge-input" aria-label={t.canvas.edgeLabel} placeholder={t.canvas.edgeLabel}
		autoFocus value={label} onChange={(event) => onLabelChange(event.target.value)}
		onBlur={() => { setEditing(false); onLabelBlur(); }}
		onKeyDown={(event) => {
			if (isImeComposing(event.nativeEvent) || event.key !== "Enter") return;
			event.preventDefault();
			event.stopPropagation();
			onFinish();
		}} />;
	return <CanvasToolbar className="canvas-selection-tools" label={t.canvas.edgeActions}>
		<CanvasAction icon="edit" label={t.canvas.editEdgeLabel} showLabel onClick={() => setEditing(true)} />
		<CanvasAction icon="remove" label={t.common.delete} showLabel onClick={onDelete} />
	</CanvasToolbar>;
}
