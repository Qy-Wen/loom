import type { CanvasNode, CanvasSide } from "../../../shared/canvas.ts";

export type Point = { x: number; y: number };
export type Viewport = Point & { scale: number };

export function worldPoint(view: Viewport, point: Point): Point {
	return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

export function zoomAt(view: Viewport, point: Point, ratio: number): Viewport {
	const scale = Math.max(0.125, Math.min(4, view.scale * ratio));
	const origin = worldPoint(view, point);
	return { x: point.x - origin.x * scale, y: point.y - origin.y * scale, scale };
}

export function fitNodes(nodes: CanvasNode[], width: number, height: number): Viewport {
	if (!nodes.length) return { x: 36, y: 36, scale: 1 };
	let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
	for (const node of nodes) {
		left = Math.min(left, node.x); top = Math.min(top, node.y);
		right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
	}
	const scale = Math.max(0.125, Math.min(1, (width - 64) / (right - left), (height - 64) / (bottom - top)));
	return { x: width / 2 - (left + right) / 2 * scale, y: height / 2 - (top + bottom) / 2 * scale, scale };
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

export function containsCard(area: { x: number; y: number; width: number; height: number }, node: CanvasNode): boolean {
	return area.x <= node.x && area.y <= node.y
		&& area.x + area.width >= node.x + node.width && area.y + area.height >= node.y + node.height;
}

export function movingCards(nodes: CanvasNode[], picked: ReadonlySet<string>): ReadonlySet<string> {
	const groups = nodes.filter((node) => node.type === "group" && picked.has(node.id));
	if (!groups.length) return picked;
	return new Set([...picked, ...nodes.filter((node) => groups.some((group) => containsCard(group, node))).map((node) => node.id)]);
}
