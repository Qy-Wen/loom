import type { CanvasEdge, CanvasNode, CanvasSide } from "../../../shared/canvas.ts";

export type Point = { x: number; y: number };
export type Viewport = Point & { scale: number };

export function fitMediaNode(node: CanvasNode, ratio?: number): CanvasNode {
	if (!ratio) return node;
	const width = Math.min(node.width, node.height * ratio);
	return { ...node, width, height: width / ratio };
}

export function reshapeNode(node: CanvasNode, delta: Point, resize: boolean, ratio?: number): CanvasNode {
	const x = Math.round(delta.x), y = Math.round(delta.y);
	if (!x && !y) return node;
	if (!resize) return { ...node, x: node.x + x, y: node.y + y };
	if (!ratio) return { ...node, width: Math.max(96, node.width + x), height: Math.max(72, node.height + y) };
	const { width, height } = fitMediaNode(node, ratio);
	const longestSide = Math.max(width, height);
	// Project the pointer movement onto the resize diagonal so both edges move together.
	const direction = { x: width / longestSide, y: height / longestSide };
	const change = (delta.x * direction.x + delta.y * direction.y) / (direction.x ** 2 + direction.y ** 2);
	const nextSide = Math.max(1, Math.min(longestSide, 96), Math.min(Number.MAX_SAFE_INTEGER, Math.round(longestSide + change)));
	// JSON Canvas stores integer sizes. Round up the shorter side so fitting it again preserves the long side.
	return { ...node, width: Math.ceil(nextSide * direction.x), height: Math.ceil(nextSide * direction.y) };
}

export function worldPoint(view: Viewport, point: Point): Point {
	return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

export function zoomAt(view: Viewport, point: Point, ratio: number): Viewport {
	const scale = Math.max(0.125, Math.min(4, view.scale * ratio));
	const origin = worldPoint(view, point);
	return { x: point.x - origin.x * scale, y: point.y - origin.y * scale, scale };
}

export function nodeBounds(nodes: readonly CanvasNode[]): { x: number; y: number; width: number; height: number } | undefined {
	if (!nodes.length) return;
	let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
	for (const node of nodes) {
		left = Math.min(left, node.x); top = Math.min(top, node.y);
		right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export function fitNodes(nodes: CanvasNode[], width: number, height: number): Viewport {
	const bounds = nodeBounds(nodes);
	if (!bounds) return { x: 36, y: 36, scale: 1 };
	const scale = Math.max(0.125, Math.min(1, (width - 64) / bounds.width, (height - 64) / bounds.height));
	return { x: width / 2 - (bounds.x + bounds.width / 2) * scale, y: height / 2 - (bounds.y + bounds.height / 2) * scale, scale };
}

function center(node: CanvasNode): Point {
	return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

export function facingSide(from: CanvasNode, to: CanvasNode): CanvasSide {
	const a = center(from), b = center(to);
	const dx = b.x - a.x, dy = b.y - a.y;
	if (Math.abs(dx) * from.height >= Math.abs(dy) * from.width) return dx < 0 ? "left" : "right";
	return dy < 0 ? "top" : "bottom";
}

export function edgePoint(node: CanvasNode, side: CanvasSide): Point {
	const point = center(node);
	if (side === "left") point.x = node.x;
	if (side === "right") point.x = node.x + node.width;
	if (side === "top") point.y = node.y;
	if (side === "bottom") point.y = node.y + node.height;
	return point;
}

const sideDirections: Record<CanvasSide, Point> = {
	top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};

export function connectionCurve(start: Point, fromSide: CanvasSide, end: Point, toSide?: CanvasSide): { path: string; midpoint: Point } {
	const bend = Math.min(96, Math.hypot(end.x - start.x, end.y - start.y) * 0.45);
	const from = sideDirections[fromSide];
	const to = toSide ? sideDirections[toSide] : { x: -from.x, y: -from.y };
	const a = { x: start.x + from.x * bend, y: start.y + from.y * bend };
	const b = { x: end.x + to.x * bend, y: end.y + to.y * bend };
	return {
		path: `M ${start.x} ${start.y} C ${a.x} ${a.y} ${b.x} ${b.y} ${end.x} ${end.y}`,
		midpoint: { x: (start.x + 3 * a.x + 3 * b.x + end.x) / 8, y: (start.y + 3 * a.y + 3 * b.y + end.y) / 8 },
	};
}

export function edgeCurve(edge: CanvasEdge, from: CanvasNode, to: CanvasNode): ReturnType<typeof connectionCurve> {
	const fromSide = edge.fromSide ?? facingSide(from, to);
	const toSide = edge.toSide ?? facingSide(to, from);
	return connectionCurve(edgePoint(from, fromSide), fromSide, edgePoint(to, toSide), toSide);
}

export function containsCard(area: { x: number; y: number; width: number; height: number }, node: CanvasNode): boolean {
	return area.x <= node.x && area.y <= node.y
		&& area.x + area.width >= node.x + node.width && area.y + area.height >= node.y + node.height;
}

export function movingCards(nodes: CanvasNode[], picked: ReadonlySet<string>): ReadonlySet<string> {
	const groups = nodes.filter((node) => node.type === "group" && picked.has(node.id));
	if (!groups.length) return picked;
	return new Set([...picked, ...nodes.filter((node) => groups.some((group) => containsCard(group, node))).map((node) => node.id)]);
}
