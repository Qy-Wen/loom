import { memo } from "react";
import type { Asset } from "@loom/core";
import { AssetThumbnail } from "../../assets/asset-thumbnail.tsx";
import { GRAPH_NODE_RADIUS, GRAPH_SELECTION_RING_RADIUS, type GraphNodeDetail } from "./graph-layout.ts";

interface GraphNodeProps {
	asset: Asset;
	color: string;
	x: number;
	y: number;
	selected: boolean;
	dropTarget: boolean;
	hovered: boolean;
	detail: GraphNodeDetail;
	onPointerDown: (event: React.PointerEvent<SVGGElement>, assetId: string) => void;
}

/**
 * One node. The simulation moves nodes in place, so position arrives as plain numbers: a node that did not move,
 * change selection or change detail is skipped by `memo` instead of being re-rendered on every tick or mouse move.
 */
export const GraphNode = memo(function GraphNode({
	asset,
	color,
	x,
	y,
	selected,
	dropTarget,
	hovered,
	detail,
	onPointerDown,
}: GraphNodeProps): React.JSX.Element {
	const radius = GRAPH_NODE_RADIUS;
	return (
		<g
			className={`graph-node${selected ? " selected" : ""}${dropTarget ? " drop-target" : ""}${hovered ? " hovered" : ""}`}
			data-asset-id={asset.assetId}
			transform={`translate(${x} ${y})`}
			onPointerDown={(event) => onPointerDown(event, asset.assetId)}
		>
			<title>{asset.filename}</title>
			{detail === "full" && (
				<foreignObject
					className="graph-node-preview"
					x={-radius}
					y={-radius}
					width={radius * 2}
					height={radius * 2}
					aria-hidden="true"
				>
					<AssetThumbnail asset={asset} />
				</foreignObject>
			)}
			<circle
				className="graph-node-outline"
				r={radius}
				fill={detail === "dot" ? color : "none"}
				stroke={color}
			/>
			{selected && <circle className="graph-node-selection-ring" r={GRAPH_SELECTION_RING_RADIUS} aria-hidden="true" />}
			{detail === "full" && (
				<text className="graph-node-name" y={radius + 14} textAnchor="middle">
					{truncate(asset.filename)}
				</text>
			)}
		</g>
	);
});

function truncate(filename: string): string {
	return filename.length > 22 ? `${filename.slice(0, 21)}…` : filename;
}
