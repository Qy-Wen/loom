export const GRAPH_NODE_RADIUS = 14;
export const GRAPH_SELECTED_RADIUS = 18;
export const GRAPH_PLUS_OFFSET = 10;
export const GRAPH_SNAP_PAD = 16;

export type NodeHitZone = "body" | "rim" | "none";

/** Inner disc moves the node; the rim band is the link handle. */
export function nodeHitZone(distance: number, radius: number): NodeHitZone {
	if (distance <= radius * 0.62) return "body";
	if (distance <= radius + GRAPH_PLUS_OFFSET + 6) return "rim";
	return "none";
}

export function nearestNode<T extends { id: string; x: number; y: number }>(
	nodes: T[],
	x: number,
	y: number,
	excludeId: string | null,
	snapRadius: number,
): T | undefined {
	let best: T | undefined;
	let bestDist = snapRadius;
	for (const node of nodes) {
		if (node.id === excludeId) continue;
		const dist = Math.hypot(x - node.x, y - node.y);
		if (dist <= bestDist) {
			best = node;
			bestDist = dist;
		}
	}
	return best;
}

export interface GraphLayoutNode {
	id: string;
	x: number;
	y: number;
}

export interface GraphLayoutEdge {
	fromId: string;
	toId: string;
}

/** Deterministic Fruchterman-Reingold layout. Isolated nodes stay in the ring. */
export function layoutForceGraph(
	ids: string[],
	edges: GraphLayoutEdge[],
	iterations = 120,
): GraphLayoutNode[] {
	const n = ids.length;
	if (n === 0) return [];
	if (n === 1) return [{ id: ids[0]!, x: 0, y: 0 }];

	const index = new Map(ids.map((id, i) => [id, i]));
	const radius = 48 * Math.sqrt(n);
	const nodes = ids.map((id, i) => {
		const angle = (2 * Math.PI * i) / n - Math.PI / 2;
		return { id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
	});
	const k = Math.max(64, 240 / Math.sqrt(n));
	const steps = Math.min(iterations, 40 + n * 2);

	for (let step = 0; step < steps; step++) {
		const cool = 1 - step / steps;
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const left = nodes[i]!;
				const right = nodes[j]!;
				let dx = left.x - right.x;
				let dy = left.y - right.y;
				const dist = Math.hypot(dx, dy) || 0.01;
				const force = (k * k) / dist;
				dx = (dx / dist) * force;
				dy = (dy / dist) * force;
				left.vx += dx;
				left.vy += dy;
				right.vx -= dx;
				right.vy -= dy;
			}
		}
		for (const edge of edges) {
			const from = index.get(edge.fromId);
			const to = index.get(edge.toId);
			if (from === undefined || to === undefined || from === to) continue;
			const left = nodes[from]!;
			const right = nodes[to]!;
			let dx = left.x - right.x;
			let dy = left.y - right.y;
			const dist = Math.hypot(dx, dy) || 0.01;
			const force = (dist * dist) / k;
			dx = (dx / dist) * force;
			dy = (dy / dist) * force;
			left.vx -= dx;
			left.vy -= dy;
			right.vx += dx;
			right.vy += dy;
		}
		for (const node of nodes) {
			node.x += node.vx * 0.08 * cool;
			node.y += node.vy * 0.08 * cool;
			node.vx *= 0.65;
			node.vy *= 0.65;
		}
	}

	return nodes.map(({ id, x, y }) => ({ id, x, y }));
}

export function graphBounds(nodes: GraphLayoutNode[], pad = 72): {
	minX: number;
	minY: number;
	width: number;
	height: number;
} {
	if (nodes.length === 0) return { minX: -pad, minY: -pad, width: pad * 2, height: pad * 2 };
	let minX = nodes[0]!.x;
	let maxX = minX;
	let minY = nodes[0]!.y;
	let maxY = minY;
	for (const node of nodes) {
		minX = Math.min(minX, node.x);
		maxX = Math.max(maxX, node.x);
		minY = Math.min(minY, node.y);
		maxY = Math.max(maxY, node.y);
	}
	return {
		minX: minX - pad,
		minY: minY - pad,
		width: Math.max(pad * 2, maxX - minX + pad * 2),
		height: Math.max(pad * 2, maxY - minY + pad * 2),
	};
}
