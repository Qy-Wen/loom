import { memo } from "react";

interface GraphEdgeProps {
	relationId: string;
	type: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	selected: boolean;
	showLabel: boolean;
	onSelect: (relationId: string) => void;
}

/** One relation line. Plain numeric props let `memo` skip every edge that did not move or change selection. */
export const GraphEdge = memo(function GraphEdge({
	relationId,
	type,
	x1,
	y1,
	x2,
	y2,
	selected,
	showLabel,
	onSelect,
}: GraphEdgeProps): React.JSX.Element {
	return (
		<g
			className={`graph-edge-group${selected ? " selected" : ""}`}
			onPointerDown={(event) => {
				event.stopPropagation();
				onSelect(relationId);
			}}
		>
			<line className="graph-edge-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
			<line
				className="graph-edge"
				x1={x1}
				y1={y1}
				x2={x2}
				y2={y2}
				markerEnd={selected ? "url(#graph-arrow-selected)" : "url(#graph-arrow)"}
			>
				<title>{type}</title>
			</line>
			{showLabel && (
				<text className="graph-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle">
					{type}
				</text>
			)}
		</g>
	);
});
