/** The standard JSON Canvas 1.0 fields and Loom's optional asset reference. */
export interface CanvasNode {
	id: string;
	type: "text" | "file" | "link" | "group";
	x: number;
	y: number;
	width: number;
	height: number;
	text?: string;
	file?: string;
	url?: string;
	label?: string;
	color?: string;
	loom?: { assetId?: string; [key: string]: unknown };
	[key: string]: unknown;
}

export type CanvasSide = "top" | "right" | "bottom" | "left";

export interface CanvasEdge {
	id: string;
	fromNode: string;
	toNode: string;
	fromSide?: CanvasSide;
	toSide?: CanvasSide;
	fromEnd?: "none" | "arrow";
	toEnd?: "none" | "arrow";
	label?: string;
	color?: string;
	[key: string]: unknown;
}

export interface CanvasDocument {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	[key: string]: unknown;
}

export interface CanvasSnapshot {
	document: CanvasDocument;
	revision: string;
}

export function isCanvasFile(path: string): boolean {
	return /\.canvas$/i.test(path);
}

export function isCanvasLibraryPath(value: unknown): value is string {
	return typeof value === "string" && !/^[a-z]:|[\\\u0000-\u001f]/i.test(value)
		&& value.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".loom");
}

export function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown, name: string): Record<string, unknown>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(plainObject)) throw new Error(`Invalid canvas ${name}`);
	return value;
}

function idSet(rows: Record<string, unknown>[], name: string): Set<string> {
	const ids = new Set<string>();
	for (const row of rows) {
		if (typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)) throw new Error(`Invalid or duplicate canvas ${name} ID`);
		ids.add(row.id);
	}
	return ids;
}

const sides = new Set<unknown>(["top", "right", "bottom", "left"]);
const ends = new Set<unknown>(["none", "arrow"]);

export function parseCanvas(value: unknown): CanvasDocument {
	if (!plainObject(value)) throw new Error("Invalid canvas document");
	const nodes = records(value.nodes, "nodes");
	const edges = records(value.edges, "edges");
	const nodeIds = idSet(nodes, "node");
	idSet(edges, "edge");
	for (const node of nodes) {
		if (!["x", "y", "width", "height"].every((key) => Number.isSafeInteger(node[key]))
			|| Number(node.width) <= 0 || Number(node.height) <= 0) throw new Error(`Invalid geometry for canvas node ${node.id}`);
		const validType = (node.type === "text" && typeof node.text === "string")
			|| (node.type === "file" && isCanvasLibraryPath(node.file))
			|| (node.type === "link" && typeof node.url === "string")
			|| (node.type === "group" && (node.label === undefined || typeof node.label === "string"));
		if (!validType) throw new Error(`Invalid content for canvas node ${node.id}`);
		if (node.loom !== undefined && (!plainObject(node.loom)
			|| (node.loom.assetId !== undefined && (typeof node.loom.assetId !== "string" || !node.loom.assetId.trim())))) {
			throw new Error(`Invalid asset reference for canvas node ${node.id}`);
		}
	}
	for (const edge of edges) {
		if (typeof edge.fromNode !== "string" || !nodeIds.has(edge.fromNode)
			|| typeof edge.toNode !== "string" || !nodeIds.has(edge.toNode)
			|| (edge.label !== undefined && typeof edge.label !== "string")
			|| (edge.fromSide !== undefined && !sides.has(edge.fromSide))
			|| (edge.toSide !== undefined && !sides.has(edge.toSide))
			|| (edge.fromEnd !== undefined && !ends.has(edge.fromEnd))
			|| (edge.toEnd !== undefined && !ends.has(edge.toEnd))) throw new Error(`Invalid canvas edge ${edge.id}`);
	}
	return { ...value, nodes: nodes as CanvasNode[], edges: edges as CanvasEdge[] };
}

export function removeCanvasElements(document: CanvasDocument, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): CanvasDocument {
	return {
		...document,
		nodes: document.nodes.filter((node) => !nodeIds.has(node.id)),
		edges: document.edges.filter((edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.fromNode) && !nodeIds.has(edge.toNode)),
	};
}
