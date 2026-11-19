import type { AssetRelation } from "@loom/core";
import { GRAPH_NODE_OUTER_RADIUS, GRAPH_NODE_RADIUS, segmentMayCross, type WorldRect } from "./graph-layout.ts";

export const GRAPH_ARROW_SIZE = 5.5;
export const GRAPH_ARROW_REF_X = 2;
const ARROW_TIP_INSET = GRAPH_NODE_OUTER_RADIUS + 2.5;
// The shaft stops inside the marker; its tip advances the remaining distance toward the node.
const ARROW_ATTACHMENT_INSET = ARROW_TIP_INSET + GRAPH_ARROW_SIZE - GRAPH_ARROW_REF_X;
const BUNDLE_START_INSET = GRAPH_NODE_OUTER_RADIUS + 4.25;
const MIDPOINT_GAP = 16;
const MAX_TANGENT_LENGTH = 48;
const MAX_ENDPOINT_SINE = Math.sin(Math.PI / 9);

type Point = { x: number; y: number };
type EdgeLane = { slot: number; halfSpan: number };

const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function indexParallelEdges(edges: readonly AssetRelation[]): Map<string, EdgeLane> {
	const groups = new Map<string, AssetRelation[]>();
	for (const edge of edges) {
		const { fromAssetId, toAssetId } = edge;
		const key = fromAssetId < toAssetId ? `${fromAssetId}\0${toAssetId}` : `${toAssetId}\0${fromAssetId}`;
		const group = groups.get(key) ?? [];
		group.push(edge);
		groups.set(key, group);
	}

	const lanes = new Map<string, EdgeLane>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		group.sort((a, b) => compareIds(a.fromAssetId, b.fromAssetId) || compareIds(a.relationId, b.relationId));
		const halfSpan = (group.length - 1) / 2;
		group.forEach((edge, index) => {
			// Assign sides in the pair's common orientation, then convert to the edge's own normal.
			const direction = edge.fromAssetId < edge.toAssetId ? 1 : -1;
			lanes.set(edge.relationId, { slot: (index - halfSpan) * direction, halfSpan });
		});
	}
	return lanes;
}

export function routeGraphEdge(from: Point, to: Point, lane?: EdgeLane, viewport?: WorldRect | null) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.hypot(dx, dy);
	const startInset = lane ? BUNDLE_START_INSET : GRAPH_NODE_RADIUS;
	const span = distance - startInset - ARROW_ATTACHMENT_INSET;
	if (span <= 0) return null;

	const offset = lane ? lane.slot * MIDPOINT_GAP : 0;
	if (viewport && !segmentMayCross(viewport, from.x, from.y, to.x, to.y, Math.abs(offset))) return null;

	const ux = dx / distance;
	const uy = dy / distance;
	const midpointHandle = span / 6;
	const tangentLength = Math.min(midpointHandle, MAX_TANGENT_LENGTH);
	const endControlRadius = ARROW_ATTACHMENT_INSET + tangentLength;
	// The endpoints occupy a narrow arc, independently of the width at the midpoint.
	const sin = lane ? offset * Math.min(
		1 / (endControlRadius + tangentLength),
		MAX_ENDPOINT_SINE / (lane.halfSpan * MIDPOINT_GAP),
	) : 0;
	const cos = Math.sqrt(1 - sin * sin);
	// Each endpoint and its control point lie on the same ray from the node centre.
	const fromRayX = ux * cos - uy * sin;
	const fromRayY = uy * cos + ux * sin;
	const toRayX = -ux * cos - uy * sin;
	const toRayY = -uy * cos + ux * sin;
	const start = `M ${from.x + fromRayX * startInset} ${from.y + fromRayY * startInset}`;
	const end = `${to.x + toRayX * ARROW_ATTACHMENT_INSET} ${to.y + toRayY * ARROW_ATTACHMENT_INSET}`;
	const labelAlong = lane ? distance / 2 : (distance + startInset - ARROW_ATTACHMENT_INSET) / 2;
	const labelX = from.x + ux * labelAlong - uy * offset;
	const labelY = from.y + uy * labelAlong + ux * offset;
	let path;
	if (offset) {
		const startControlRadius = startInset + tangentLength;
		const fromControl = `${from.x + fromRayX * startControlRadius} ${from.y + fromRayY * startControlRadius}`;
		const midpointControl = `${labelX - ux * midpointHandle} ${labelY - uy * midpointHandle}`;
		const toControl = `${to.x + toRayX * endControlRadius} ${to.y + toRayY * endControlRadius}`;
		path = `${start} C ${fromControl} ${midpointControl} ${labelX} ${labelY} S ${toControl} ${end}`;
	} else {
		path = `${start} L ${end}`;
	}
	const labelDirection = dx < 0 || (dx === 0 && dy < 0) ? -1 : 1;
	return {
		path,
		labelX,
		labelY,
		labelAngle: lane ? Math.atan2(dy * labelDirection, dx * labelDirection) * 180 / Math.PI : 0,
	};
}
