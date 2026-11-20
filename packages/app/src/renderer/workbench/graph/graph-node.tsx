import { memo } from "react";
import type { Asset } from "@loom/core";
import { AssetThumbnail } from "../../assets/asset-thumbnail.tsx";
import { isImeComposing } from "../../components/ime-composition.ts";
import { GRAPH_NODE_OUTLINE_WIDTH, GRAPH_NODE_RADIUS, type GraphNodeDetail } from "./graph-layout.ts";

const SELECTION_RING_WIDTH = 2.5;

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
	onDoubleClick: (assetId: string) => void;
	onOpen: (assetId: string) => void;
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
	onDoubleClick,
	onOpen,
}: GraphNodeProps): React.JSX.Element {
	const radius = GRAPH_NODE_RADIUS;
	const outlineWidth = dropTarget ? 4 : hovered && !selected ? 2.5 : GRAPH_NODE_OUTLINE_WIDTH;
	const ringRadius = radius + (outlineWidth + SELECTION_RING_WIDTH) / 2;
	return (
		<g
			className={`graph-node${selected ? " selected" : ""}${dropTarget ? " drop-target" : ""}${hovered ? " hovered" : ""}`}
			data-asset-id={asset.assetId}
			role="button"
			tabIndex={0}
			aria-label={asset.filename}
			data-tooltip={asset.filename}
			transform={`translate(${x} ${y})`}
			onPointerDown={(event) => onPointerDown(event, asset.assetId)}
			onDoubleClick={() => onDoubleClick(asset.assetId)}
			onKeyDown={(event) => {
				if (isImeComposing(event.nativeEvent)) return;
				if (event.key === " ") event.preventDefault();
				if (event.key === "Enter" && !event.repeat) {
					event.preventDefault();
					onOpen(asset.assetId);
				}
			}}
			onKeyUp={(event) => {
				if (event.key === " " && !isImeComposing(event.nativeEvent)) onOpen(asset.assetId);
			}}
		>
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
				strokeWidth={outlineWidth}
			/>
			{selected && <circle className="graph-node-selection-ring" r={ringRadius} strokeWidth={SELECTION_RING_WIDTH} aria-hidden="true" />}
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
