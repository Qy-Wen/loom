import type { LocalCore } from "@loom/core";
import type { LoomTool, LoomToolResult } from "@loom/agent";

/**
 * Agent-facing relation tools. Media tools do not write edges; the agent calls these.
 */
export function createRelationTools(core: LocalCore): LoomTool[] {
	return [
		{
			name: "create_relation",
			description:
				"Create one directed relation from fromAssetId to toAssetId. " +
				"For a derived file, fromAssetId is the new file and toAssetId is its source. " +
				"Copy both asset ids from tool results. Do not invent them. " +
				"type is a short label such as \"derived from\". RELATED is reserved.",
			parameters: objectSchema({
				fromAssetId: { type: "string", description: "Asset id of the file the relation starts from." },
				toAssetId: { type: "string", description: "Asset id of the file the relation points to." },
				type: { type: "string", description: "Relation label, up to 64 characters. Not RELATED." },
			}, ["fromAssetId", "toAssetId", "type"]),
			execute: async (rawArgs) => {
				const relation = await core.createRelation(
					requiredText(rawArgs, "fromAssetId"),
					requiredText(rawArgs, "toAssetId"),
					requiredText(rawArgs, "type"),
				);
				return jsonResult(relation);
			},
		},
		{
			name: "remove_relation",
			description:
				"Delete one relation by the relationId that create_relation or inspect_asset returned.",
			parameters: objectSchema({
				relationId: { type: "string", description: "relationId from create_relation or inspect_asset." },
			}, ["relationId"]),
			execute: async (rawArgs) => {
				const relationId = requiredText(rawArgs, "relationId");
				await core.removeRelation(relationId);
				return jsonResult({ removed: relationId });
			},
		},
	];
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
	return { type: "object", properties, required, additionalProperties: false };
}

function jsonResult(details: unknown): LoomToolResult {
	return { content: JSON.stringify(details), details };
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("arguments must be an object");
	}
	return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string): string {
	const record = asRecord(value);
	if (typeof record[name] !== "string" || !record[name].trim()) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return record[name].trim();
}
