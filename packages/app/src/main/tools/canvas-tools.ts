import type { LocalCore } from "@loom/core";
import { jsonToolResult, type LoomTool } from "@loom/agent/tools";
import { isCanvasFile, plainObject, removeCanvasElements } from "../../shared/canvas.ts";
import type { CanvasStore } from "../canvas/store.ts";

const text = { type: "string" };
const integer = { type: "integer" };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const nodes = schema({
	id: text, type: { type: "string", enum: ["text", "file", "link", "group"] },
	x: integer, y: integer, width: integer, height: integer,
	text, file: text, assetId: text, url: text, label: text, color: text,
}, ["id"]);
const side = { type: "string", enum: ["top", "right", "bottom", "left"] };
const edges = schema({ id: text, fromNode: text, toNode: text, fromSide: side, toSide: side, label: text }, ["id"]);

function stringArg(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function arrayArg(value: unknown): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("Expected an array of canvas changes");
	return value;
}

function changes(value: unknown): Record<string, unknown>[] {
	return arrayArg(value).map((row) => {
		if (!plainObject(row)) throw new Error("Invalid canvas change");
		stringArg(row.id, "id");
		return row;
	});
}

function upsert<T extends { id: string }>(current: T[], incoming: Record<string, unknown>[]): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>(current.map((row) => [row.id, { ...row }]));
	for (const row of incoming) {
		const id = row.id as string;
		byId.set(id, { ...byId.get(id), ...row });
	}
	return [...byId.values()];
}

export function createCanvasTools(core: LocalCore, store: CanvasStore): LoomTool[] {
	return [
		{
			name: "list_canvases",
			description: "List .canvas documents in the open library with their asset IDs and relative paths.",
			parameters: schema({}),
			execute: async () => {
				const { assets } = await core.getLibrarySnapshot();
				return jsonToolResult(assets.filter((asset) => isCanvasFile(asset.filename))
					.map(({ assetId, relativePath }) => ({ assetId, relativePath })));
			},
		},
		{
			name: "create_canvas",
			description: "Create a new empty canvas in a library folder. Returns its asset ID and path.",
			parameters: schema({ folder: { ...text, description: "Library-relative folder. Omit for the library root." }, name: { ...text, description: "File name without .canvas." } }),
			execute: async (raw) => {
				const { folder = "", name } = raw as { folder?: unknown; name?: unknown };
				const { assetId, relativePath } = await store.create(folder, name);
				return jsonToolResult({ assetId, relativePath });
			},
		},
		{
			name: "read_canvas",
			description: "Read the nodes, edges, and current revision of a canvas by its asset ID. Node IDs are local to this canvas.",
			parameters: schema({ assetId: text }, ["assetId"]),
			execute: async (raw) => jsonToolResult(await store.read(stringArg((raw as { assetId: unknown }).assetId, "assetId"))),
		},
		{
			name: "edit_canvas",
			description: "Apply one set of changes to a canvas using the revision from read_canvas. Supply node and edge changes by ID. For a new node supply type, x, y, width and height. Use assetId for a file node to reference an existing library asset. Existing nodes and edges accept partial updates, and removing a node also removes its incident edges. Use a new ID when placing an existing asset a second time.",
			parameters: schema({ assetId: text, revision: text, nodes: { type: "array", items: nodes }, edges: { type: "array", items: edges }, removeNodes: { type: "array", items: text }, removeEdges: { type: "array", items: text } }, ["assetId", "revision"]),
			execute: async (raw) => {
				if (!plainObject(raw)) throw new Error("Invalid canvas edit");
				const assetId = stringArg(raw.assetId, "assetId");
				const current = await store.read(assetId);
				if (current.revision !== raw.revision) throw new Error("Canvas changed. Read it again before applying edits.");
				const removedNodes = new Set(arrayArg(raw.removeNodes).map((id) => stringArg(id, "node ID")));
				const removedEdges = new Set(arrayArg(raw.removeEdges).map((id) => stringArg(id, "edge ID")));
				const document = removeCanvasElements(current.document, removedNodes, removedEdges);
				const nodeChanges = await Promise.all(changes(raw.nodes).map(async ({ assetId: source, ...node }) => {
					if (source === undefined) return node;
					const asset = await core.getAsset(stringArg(source, "source asset ID"));
					if (!asset) throw new Error("Referenced asset not found");
					const previous = document.nodes.find((item) => item.id === node.id);
					return { ...node, file: asset.relativePath, loom: { ...previous?.loom, assetId: asset.assetId } };
				}));
				const saved = await store.save(assetId, {
					...document, nodes: upsert(document.nodes, nodeChanges), edges: upsert(document.edges, changes(raw.edges)),
				}, current.revision);
				if (!saved) throw new Error("Canvas changed. Read it again before applying edits.");
				return jsonToolResult(saved);
			},
		},
	];
}
