import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { LocalCore } from "@loom/core";
import { jsonToolResult, type LoomTool } from "@loom/agent/tools";

const string = { type: "string", minLength: 1 };
const folder = { type: "string", description: "Library-relative folder; empty string means the library root." };
const schema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });

export function createLibraryTools(core: LocalCore): LoomTool[] {
	const root = async () => { const { rootPath } = await core.getLibrarySnapshot(); if (!rootPath) throw new Error("Open a library first"); return rootPath; };
	return [
		{
			name: "get_library", description: "Get the open library identity, root path, folders, and available capabilities. Connect again after switching libraries.", parameters: schema({}),
			execute: async () => { const snapshot = await core.getLibrarySnapshot(); const rootPath = await root(); return jsonToolResult({ libraryId: rootPath, name: basename(rootPath), rootPath, folders: snapshot.folders, capabilities: ["search", "read", "organize", "metadata", "media", "canvas"] }); },
		},
		{
			name: "read_asset", description: "Read a text asset by ID (1-based line offset, default 200 lines, at most 50 KiB UTF-8). Read supported static images up to 5 MiB, or an image/video thumbnail. GIF and large images use a static thumbnail. Audio and whole videos are not returned. Text input is limited to 32 MiB.",
			parameters: schema({ assetId: string, view: { type: "string", enum: ["content", "thumbnail"] }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["assetId"]),
			execute: async (raw, signal) => {
				const { assetId, view = "content", offset = 1, limit = 200 } = raw as { assetId: string; view?: string; offset?: number; limit?: number };
				const asset = await core.getAsset(assetId);
				if (!asset) throw new Error("Asset not found");
				const source = await core.getAssetFilePath(assetId);
				if (!source) throw new Error("Asset not found");
				if (asset.type === "text" && view === "content") {
					const path = source;
					if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("Text input exceeds 32 MiB");
					const lines: string[] = []; let line = 1; let bytes = 0; let pending = ""; let truncated = false;
					const stream = createReadStream(path, { encoding: "utf8", signal, highWaterMark: 16 * 1024 });
					const append = (text: string) => {
						if (line++ < offset) return true;
						const size = Buffer.byteLength(text) + 1;
						if (size > 50 * 1024 && lines.length === 0) throw new Error("A text line exceeds 50 KiB");
						if (lines.length >= limit || bytes + size > 50 * 1024) { truncated = true; return false; }
						lines.push(text.replace(/\r$/, "")); bytes += size; return true;
					};
					try {
						outer: for await (const chunk of stream) {
							pending += chunk;
							let newline: number;
							while ((newline = pending.indexOf("\n")) >= 0) { const text = pending.slice(0, newline); pending = pending.slice(newline + 1); if (!append(text)) break outer; }
							if (pending.length > 50 * 1024) throw new Error("A text line exceeds 50 KiB; use a smaller source file");
						}
						if (!truncated && pending) append(pending);
					} finally { stream.destroy(); }
					return jsonToolResult({ assetId, offset, lines: lines.length, text: lines.join("\n"), truncated, ...(truncated ? { nextOffset: offset + lines.length } : {}) });
				}
				if (asset.type !== "image" && asset.type !== "video") throw new Error("Only text, images, and video thumbnails can be read");
				const direct = view === "content" && asset.type === "image" && asset.size <= 5 * 1024 * 1024 && /\.(png|jpe?g|webp)$/i.test(asset.filename);
				const path = direct ? source : await core.getThumbnailPath(assetId, signal);
				if (!path) throw new Error("No thumbnail available");
				if ((await stat(path)).size > 5 * 1024 * 1024) throw new Error("Image exceeds 5 MiB");
				const mimeType = ({ ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" } as Record<string, string>)[extname(path).toLowerCase()];
				if (!mimeType) throw new Error("Unsupported image format");
				return { content: [{ type: "image", mimeType, data: (await readFile(path, { signal })).toString("base64") }], data: { assetId, view: direct ? "content" : "thumbnail", mimeType } };
			},
		},
		{
			name: "rename_asset", description: "Rename an asset's stem in place. Preserves its extension and stable ID; existing names are rejected.", parameters: schema({ assetId: string, stem: string }),
			execute: async (raw, signal) => {
				const { assetId, stem } = raw as { assetId: string; stem: string };
				signal?.throwIfAborted();
				return jsonToolResult(await core.renameAsset(assetId, stem));
			},
		},
		{
			name: "move_assets", description: "Move assets into an existing library folder. Returns per-item success or error; earlier moves remain if a later item fails. Name collisions receive unique filenames.", parameters: schema({ assetIds: { type: "array", items: string, minItems: 1, maxItems: 100, uniqueItems: true }, destFolder: folder }),
			execute: async (raw, signal) => {
				const { assetIds, destFolder } = raw as { assetIds: string[]; destFolder: string };
				const results = [];
				for (const assetId of assetIds) {
					signal?.throwIfAborted();
					try {
						const [asset] = await core.moveAssetsInto([assetId], destFolder);
						results.push({ assetId, success: true, asset });
					} catch (error) {
						signal?.throwIfAborted();
						results.push({ assetId, success: false, error: error instanceof Error ? error.message : String(error) });
					}
				}
				return jsonToolResult({ results });
			},
		},
		{
			name: "create_folder", description: "Create a named folder under an existing library folder; empty parent means root. Existing names are rejected.", parameters: schema({ parentRelativePath: folder, name: string }),
			execute: async (raw, signal) => {
				const { parentRelativePath, name } = raw as { parentRelativePath: string; name: string };
				signal?.throwIfAborted();
				return jsonToolResult({ relativePath: await core.createFolder(parentRelativePath, name) });
			},
		},
		{
			name: "rename_folder", description: "Rename a library folder in place; preserves child asset IDs. The library root cannot be renamed.", parameters: schema({ relativePath: string, name: string }),
			execute: async (raw, signal) => {
				const { relativePath, name } = raw as { relativePath: string; name: string };
				signal?.throwIfAborted();
				return jsonToolResult({ relativePath: await core.renameFolder(relativePath, name) });
			},
		},
		{
			name: "move_folder", description: "Move a folder into an existing library folder; empty destination means root. Cannot move root or a folder into itself or its descendants. Name collisions receive a unique name.", parameters: schema({ sourceFolder: string, destFolder: folder }),
			execute: async (raw, signal) => {
				const { sourceFolder, destFolder } = raw as { sourceFolder: string; destFolder: string };
				signal?.throwIfAborted();
				return jsonToolResult({ relativePath: await core.moveFolderInto(sourceFolder, destFolder) });
			},
		},
	];
}
