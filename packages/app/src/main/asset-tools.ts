import type {
	AssetSearchQuery,
	LocalCore,
	PropertyFilterOperator,
	PropertyValue,
	TextEmbedStatus,
} from "@loom/core";
import type { LoomTool, LoomToolResult } from "@loom/agent";

interface SearchAssetsArgs {
	query?: string;
	type?: AssetSearchQuery["type"];
	properties?: Array<{
		name: string;
		operator: PropertyFilterOperator;
		value: PropertyValue;
	}>;
	limit?: number;
}

interface InspectAssetArgs {
	assetId: string;
}

interface EmbedAssetArgs {
	assetId: string;
}

export interface AssetToolOptions {
	embedAsset: (assetId: string) => Promise<TextEmbedStatus>;
}

/**
 * Agent-facing asset tools. Results contain UUIDs and relative paths only;
 * absolute filesystem paths stay behind LocalCore.
 */
export function createAssetTools(core: LocalCore, options: AssetToolOptions): LoomTool[] {
	return [
		{
			name: "search_assets",
			description:
				"Search the open local asset library by filename/path text, Level 1 extracts (file text, camera, codecs), media type, and custom properties. " +
				"Property filters are AND-combined. Returns stable asset IDs; use inspect_asset for one result.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Case-insensitive filename, relative path, property value, or Level 1 extract text." },
					type: { type: "string", enum: ["image", "video", "audio", "text", "other"] },
					properties: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								operator: { type: "string", enum: ["eq", "contains", "gte", "lte"] },
								value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
							},
							required: ["name", "operator", "value"],
							additionalProperties: false,
						},
					},
					limit: { type: "number", minimum: 1, maximum: 100 },
				},
				additionalProperties: false,
			},
			execute: async (rawArgs) => {
				const args = validateSearchArgs(rawArgs);
				const result = await core.searchAssets(args);
				return {
					content: JSON.stringify({ total: result.total, assets: result.assets }),
					details: result,
				} satisfies LoomToolResult;
			},
		},
		{
			name: "inspect_asset",
			description:
				"Inspect one asset by stable assetId. Returns file metadata, custom properties, relations (including GENERATED_FROM), and a safe preview reference. " +
				"Never accepts or returns an absolute filesystem path.",
			parameters: {
				type: "object",
				properties: {
					assetId: { type: "string", minLength: 1 },
				},
				required: ["assetId"],
				additionalProperties: false,
			},
			execute: async (rawArgs) => {
				const args = validateInspectArgs(rawArgs);
				const result = await core.inspectAsset(args.assetId);
				return {
					content: JSON.stringify(result),
					details: result,
				} satisfies LoomToolResult;
			},
		},
		{
			name: "embed_asset",
			description:
				"Index one Markdown asset for later retrieval: chunk the Level 1 extract and request embeddings. " +
				"Only .md files are supported. Uses the Embedding slot from Settings. Returns idle/embedding/ready/failed status.",
			parameters: {
				type: "object",
				properties: {
					assetId: { type: "string", minLength: 1 },
				},
				required: ["assetId"],
				additionalProperties: false,
			},
			execute: async (rawArgs) => {
				const args = validateInspectArgs(rawArgs) satisfies EmbedAssetArgs;
				const result = await options.embedAsset(args.assetId);
				return {
					content: JSON.stringify(result),
					details: result,
				} satisfies LoomToolResult;
			},
		},
	];
}

function validateSearchArgs(value: unknown): SearchAssetsArgs {
	if (!isRecord(value)) throw new TypeError("search_assets arguments must be an object");
	const result: SearchAssetsArgs = {};
	if (value.query !== undefined) {
		if (typeof value.query !== "string") throw new TypeError("query must be a string");
		result.query = value.query;
	}
	if (value.type !== undefined) {
		if (!["image", "video", "audio", "text", "other"].includes(String(value.type))) {
			throw new TypeError("type is not a supported asset type");
		}
		result.type = value.type as SearchAssetsArgs["type"];
	}
	if (value.limit !== undefined) {
		if (typeof value.limit !== "number" || !Number.isFinite(value.limit)) throw new TypeError("limit must be a number");
		result.limit = value.limit;
	}
	if (value.properties !== undefined) {
		if (!Array.isArray(value.properties)) throw new TypeError("properties must be an array");
		result.properties = value.properties.map((filter) => {
			if (!isRecord(filter) || typeof filter.name !== "string") throw new TypeError("property filter name must be a string");
			if (!["eq", "contains", "gte", "lte"].includes(String(filter.operator))) {
				throw new TypeError("property filter operator is invalid");
			}
			if (!["string", "number", "boolean"].includes(typeof filter.value)) {
				throw new TypeError("property filter value is invalid");
			}
			return {
				name: filter.name,
				operator: filter.operator as PropertyFilterOperator,
				value: filter.value as PropertyValue,
			};
		});
	}
	return result;
}

function validateInspectArgs(value: unknown): InspectAssetArgs {
	if (!isRecord(value) || typeof value.assetId !== "string" || !value.assetId.trim()) {
		throw new TypeError("assetId must be a non-empty string");
	}
	return { assetId: value.assetId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
