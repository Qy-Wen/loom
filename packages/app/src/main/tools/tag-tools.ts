import type { LocalCore } from "@loom/core";
import type { LoomTool, LoomToolResult } from "@loom/agent";

/**
 * Agent-facing tag and favorite tools. A tag is a library-wide label that goes on many files and is named by its
 * text, so the Agent never handles tag ids. Reading a file's tags and favorite state is `inspect_asset`; finding
 * files by them is the `tags` and `favorite` filters of the two search tools.
 */
export function createTagTools(core: LocalCore): LoomTool[] {
	return [
		{
			name: "list_tags",
			description:
				"List every tag in the open library with how many files carry it, most used first. " +
				"Check this before add_tag so you reuse an existing tag instead of inventing a near-duplicate.",
			parameters: objectSchema({}, []),
			execute: async () => jsonResult(await core.listTagUsage()),
		},
		{
			name: "add_tag",
			description:
				"Put a tag on one file. name is plain text, up to 64 characters; it is created if the library has no such tag. " +
				"Names match ignoring case, so \"Draft\" and \"draft\" are the same tag. Adding a tag the file already has changes nothing. " +
				"Copy assetId from tool results.",
			parameters: objectSchema({
				assetId: { type: "string", description: "Asset id of the file." },
				name: { type: "string", description: "Tag text." },
			}, ["assetId", "name"]),
			execute: async (rawArgs) => {
				const assetId = requiredText(rawArgs, "assetId");
				const name = requiredText(rawArgs, "name");
				await core.addAssetTag(assetId, name);
				return jsonResult({ assetId, tags: (await core.inspectAsset(assetId)).tags });
			},
		},
		{
			name: "remove_tag",
			description:
				"Take a tag off one file by its name, ignoring case. The tag disappears from the library when no file has it. " +
				"Returns removed: false when the file did not have that tag.",
			parameters: objectSchema({
				assetId: { type: "string", description: "Asset id of the file." },
				name: { type: "string", description: "Tag text." },
			}, ["assetId", "name"]),
			execute: async (rawArgs) => {
				const assetId = requiredText(rawArgs, "assetId");
				const removed = await core.removeAssetTagByName(assetId, requiredText(rawArgs, "name"));
				return jsonResult({ assetId, removed, tags: (await core.inspectAsset(assetId)).tags });
			},
		},
		{
			name: "set_favorite",
			description:
				"Mark one file as a favorite, or take the mark off. Setting the state it already has changes nothing. " +
				"Copy assetId from tool results.",
			parameters: objectSchema({
				assetId: { type: "string", description: "Asset id of the file." },
				favorite: { type: "boolean", description: "true to mark, false to unmark." },
			}, ["assetId", "favorite"]),
			execute: async (rawArgs) => {
				const assetId = requiredText(rawArgs, "assetId");
				const favorite = requiredBoolean(rawArgs, "favorite");
				await core.setFavorite(assetId, favorite);
				return jsonResult({ assetId, favorite });
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

function requiredBoolean(value: unknown, name: string): boolean {
	const record = asRecord(value);
	if (typeof record[name] !== "boolean") throw new TypeError(`${name} must be true or false`);
	return record[name];
}
