import { memo } from "react";

interface GraphEdgeProps {
	relationId: string;
	type: string;
	/** Edges derived from file contents are drawn dashed. */
	derived: boolean;
	path: string;
	labelX: number;
	labelY: number;
	labelAngle: number;
	selected: boolean;
	showLabel: boolean;
	onSelect: (relationId: string) => void;
}

/** One relation path. Primitive props let `memo` skip edges that did not move or change selection. */
export const GraphEdge = memo(function GraphEdge({
	relationId,
	type,
	derived,
	path,
	labelX,
	labelY,
	labelAngle,
	selected,
	showLabel,
	onSelect,
}: GraphEdgeProps): React.JSX.Element {
	return (
		<g
			className={`graph-edge-group${selected ? " selected" : ""}${derived ? " derived" : ""}`}
			data-tooltip={type}
			aria-label={type}
			onPointerDown={(event) => {
				event.stopPropagation();
				onSelect(relationId);
			}}
		>
			<path className="graph-edge-hit" d={path} />
			<path
				className="graph-edge"
				d={path}
				markerEnd={selected ? "url(#graph-arrow-selected)" : "url(#graph-arrow)"}
			/>
			{showLabel && (
				<text className="graph-edge-label" x={labelX} y={labelY - 4} transform={labelAngle ? `rotate(${labelAngle} ${labelX} ${labelY})` : undefined} textAnchor="middle">
					{type}
				</text>
			)}
		</g>
	);
});
