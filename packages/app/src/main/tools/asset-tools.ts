import type {
	AssetSearchQuery,
	AudioWriteupStatus,
	EmbedOptions,
	EmbeddingProvider,
	RerankProvider,
	ImageVlmStatus,
	LocalCore,
	PropertyFilterOperator,
	PropertyValue,
	TextEmbedStatus,
	VideoVlmStatus,
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
	tags?: string[];
	favorite?: boolean;
	limit?: number;
}

interface InspectAssetArgs {
	assetId: string;
}

interface EmbedAssetArgs {
	assetId: string;
	force?: boolean;
}

export interface AssetToolOptions {
	embedAsset: (assetId: string, signal?: AbortSignal, options?: EmbedOptions) => Promise<TextEmbedStatus>;
	embeddingProvider?: () => Promise<EmbeddingProvider | undefined>;
	rerankProvider?: () => Promise<RerankProvider | undefined>;
	describeImage: (assetId: string, signal?: AbortSignal) => Promise<ImageVlmStatus>;
	describeVideo: (assetId: string, signal?: AbortSignal) => Promise<VideoVlmStatus>;
	describeAudio: (assetId: string, signal?: AbortSignal) => Promise<AudioWriteupStatus>;
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
				"Simple search of the open local asset library: text over filename, relative path, property values, " +
				"text-file extracts, and image/video/audio captions, plus media type and custom property filters. " +
				"Uses no model and needs no index, so it sees every file, but it only matches the words you type: " +
				"it does not understand meaning and returns whole files, not passages. " +
				"Chinese, Japanese, and Korean are matched by word. A query with no text lists files by type and property. " +
				"Use it to find a file by name or exact wording. To find what a document says, or a passage by meaning, use deep_search_assets. " +
				"Returns asset IDs; use inspect_asset for one result.",
			parameters: searchParameters("Words to find in a filename, relative path, property value, text extract, or caption. Case-insensitive; every word must match."),
			execute: async (rawArgs, signal) => {
				const args = validateSearchArgs(rawArgs, "search_assets");
				const result = await core.searchAssets(args, signal);
				return {
					content: JSON.stringify({ total: result.total, assets: result.assets }),
					details: result,
				} satisfies LoomToolResult;
			},
		},
		{
			name: "deep_search_assets",
			description:
				"Deep search of what is inside indexed files: finds the best matching passage by exact words and, when an Embedding model is set, by meaning. " +
				"It only sees files that have been indexed (embed_asset): .md/.txt/.csv/.json files and described images, videos, and audio. " +
				"A file that is not indexed cannot appear; use search_assets for it. " +
				"Full-text and vector matches are fused, then an optional Rerank model reorders the passages. Each file appears once with its best passage. " +
				"Returns asset IDs with the matching passage (and its parent passage for context), plus indexedCount, the number of searchable files. " +
				"If indexedCount is 0 or small, tell the user that few files are indexed, fall back to search_assets, or index files first. " +
				"Type and property filters apply. A query is required.",
			parameters: searchParameters("What to look for. Words that appear in the passage, or a description of its meaning."),
			execute: async (rawArgs, signal) => {
				const args = validateSearchArgs(rawArgs, "deep_search_assets");
				if (!args.query?.trim()) throw new TypeError("deep_search_assets needs a non-empty query");
				const query = { ...args, query: args.query };
				return core.runLibraryTask(async (jobSignal) => {
					let provider: EmbeddingProvider | undefined;
					let rerank: RerankProvider | undefined;
					try {
						provider = await options.embeddingProvider?.();
					} catch {
						provider = undefined;
					}
					try {
						rerank = await options.rerankProvider?.();
					} catch {
						rerank = undefined;
					}
					const result = await core.deepSearchAssets(query, provider, rerank, jobSignal);
					return {
						content: JSON.stringify({ total: result.total, indexedCount: result.indexedCount, assets: result.assets }),
						details: result,
					} satisfies LoomToolResult;
				}, signal);
			},
		},
		{
			name: "inspect_asset",
			description:
				"Inspect one asset by stable assetId. Returns file metadata, custom properties, relations, " +
				"a VLM or Audio write-up when the image, video, or audio has been described, text-index status, and a safe preview reference. " +
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
				"Index one asset for later retrieval: chunk its text and request embeddings. " +
				"Supported: .md, .txt, .csv, and .json files, or images/videos/audio that already have a write-up. " +
				"An index that is already current (same file, same model) is left alone and its ready status returned; " +
				"set force only when the user asks to rebuild it, since that sends the text to the embedding model again. " +
				"Uses the Embedding slot from Settings. Returns idle/embedding/ready/failed status.",
			parameters: {
				type: "object",
				properties: {
					assetId: { type: "string", minLength: 1 },
					force: { type: "boolean", description: "Rebuild even if the index is current. Default false." },
				},
				required: ["assetId"],
				additionalProperties: false,
			},
			execute: async (rawArgs, signal) => {
				const args = validateEmbedArgs(rawArgs);
				const result = await options.embedAsset(args.assetId, signal, { force: args.force === true });
				return {
					content: JSON.stringify(result),
					details: result,
				} satisfies LoomToolResult;
			},
		},
		{
			name: "describe_image",
			description:
				"Describe one JPEG, PNG, WebP, BMP, or GIF image with the VLM slot: caption and tags as Markdown. " +
				"Does not run on import. GIF uses its first frame. Other image formats are not supported. After a ready write-up, use embed_asset to index it. " +
				"Uses the VLM slot from Settings. Returns idle/describing/ready/failed status.",
			parameters: {
				type: "object",
				properties: {
					assetId: { type: "string", minLength: 1 },
				},
				required: ["assetId"],
				additionalProperties: false,
			},
			execute: async (rawArgs, signal) => {
				const args = validateInspectArgs(rawArgs);
				const result = await options.describeImage(args.assetId, signal);
				return {
					content: JSON.stringify(result),
					details: result,
				} satisfies LoomToolResult;
			},
		},
		{
			name: "describe_video",
			description:
				"Describe one video with the VLM slot: caption and tags as Markdown. " +
				"Prefers native video when the endpoint accepts it; otherwise FFmpeg stills as image_url. " +
				"Does not run on import. After a ready write-up, use embed_asset to index it. " +
				"Uses the VLM slot from Settings. Returns idle/describing/ready/failed status.",
			parameters: {
				type: "object",
				properties: {
					assetId: { type: "string", minLength: 1 },
				},
				required: ["assetId"],
				additionalProperties: false,
			},
			execute: async (rawArgs, signal) => {
				const args = validateInspectArgs(rawArgs);
				const result = await options.describeVideo(args.assetId, signal);
				return {
					content: JSON.stringify(result),
					details: result,
				} satisfies LoomToolResult;
			},
		},
		{
			name: "describe_audio",
			description:
				"Describe one standalone audio file with the Audio slot: caption, tags, and transcript as Markdown. " +
				"Understands music and ambient sound, not speech-only ASR. Does not run on import. AAC/FLAC/M4A/MP3/OGG/WAV. " +
				"After a ready write-up, use embed_asset to index it. Uses the Audio slot from Settings. " +
				"Returns idle/describing/ready/failed status.",
			parameters: {
				type: "object",
				properties: {
					assetId: { type: "string", minLength: 1 },
				},
				required: ["assetId"],
				additionalProperties: false,
			},
			execute: async (rawArgs, signal) => {
				const args = validateInspectArgs(rawArgs);
				const result = await options.describeAudio(args.assetId, signal);
				return {
					content: JSON.stringify(result),
					details: result,
				} satisfies LoomToolResult;
			},
		},
	];
}

/** Both searches take the same arguments; only the meaning of `query` differs. */
function searchParameters(queryDescription: string) {
	return {
		type: "object",
		properties: {
			query: { type: "string", description: queryDescription },
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
			tags: {
				type: "array",
				items: { type: "string" },
				description: "Keep files that have every one of these tags. Names ignore case. A name that is not a tag matches nothing.",
			},
			favorite: { type: "boolean", description: "true keeps favorites only; false keeps files that are not favorites." },
			limit: { type: "number", minimum: 1, maximum: 100 },
		},
		additionalProperties: false,
	} as const;
}

function validateSearchArgs(value: unknown, tool: string): SearchAssetsArgs {
	if (!isRecord(value)) throw new TypeError(`${tool} arguments must be an object`);
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
	if (value.tags !== undefined) {
		if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
			throw new TypeError("tags must be an array of strings");
		}
		result.tags = value.tags as string[];
	}
	if (value.favorite !== undefined) {
		if (typeof value.favorite !== "boolean") throw new TypeError("favorite must be true or false");
		result.favorite = value.favorite;
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

function validateEmbedArgs(value: unknown): EmbedAssetArgs {
	const { assetId } = validateInspectArgs(value);
	const force = (value as Record<string, unknown>).force;
	if (force !== undefined && typeof force !== "boolean") throw new TypeError("force must be a boolean");
	return { assetId, force };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
