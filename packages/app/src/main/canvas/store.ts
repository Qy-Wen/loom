import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Asset, LocalCore } from "@loom/core";
import { LibraryPaths } from "@loom/core/paths";
import { isCanvasFile, isCanvasLibraryPath, parseCanvas, type CanvasDocument, type CanvasSnapshot } from "../../shared/canvas.ts";
import { atomicWrite, encodeJson } from "../storage/file.ts";
import { SerialQueue } from "../storage/serial-queue.ts";

const MAX_BYTES = 8 * 1024 * 1024;

function revisionOf(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

type CanvasLibrary = Pick<LocalCore, "getLibraryRoot" | "getAsset" | "createCanvasFile">;

export class CanvasStore {
	private readonly writes = new SerialQueue();
	private readonly library: CanvasLibrary;

	constructor(library: CanvasLibrary) {
		this.library = library;
	}

	async create(folder: unknown, name?: unknown): Promise<Asset> {
		if (folder !== "" && !isCanvasLibraryPath(folder)) throw new Error("Invalid canvas folder");
		const title = typeof name === "string" ? name.trim() : name;
		if (title !== undefined && (!isCanvasLibraryPath(title) || title.includes("/")
			|| /[<>:"|?*]|[.]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title))) {
			throw new Error("Enter a portable canvas name");
		}
		const root = await realpath(this.library.getLibraryRoot());
		if (folder) await checkedPath(root, folder);
		return this.library.createCanvasFile(folder, title);
	}

	async read(assetId: string): Promise<CanvasSnapshot> {
		const path = await this.filePath(assetId);
		const { text } = await readCanvasText(path);
		return { document: parseCanvas(JSON.parse(text.replace(/^\uFEFF/, ""))), revision: revisionOf(text) };
	}

	async save(assetId: string, document: unknown, expectedRevision: string): Promise<CanvasSnapshot | null> {
		const parsed = parseCanvas(document);
		if (typeof expectedRevision !== "string" || !/^[\da-f]{64}$/.test(expectedRevision)) throw new Error("Invalid canvas revision");
		const root = this.library.getLibraryRoot();
		return this.writes.run(async () => {
			if (this.library.getLibraryRoot() !== root) throw new Error("The canvas library changed");
			const path = await this.filePath(assetId);
			const { text, before } = await readCanvasText(path);
			if (revisionOf(text) !== expectedRevision) return null;
			const next = await this.refreshPaths(parsed);
			const contents = encodeJson(next);
			if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("Canvas exceeds 8 MiB");
			if (contents !== text) {
				let changed = false;
				try {
					await atomicWrite(path, contents, () => {
						let current;
						try { current = lstatSync(path, { bigint: true }); } catch { /* The file left this path. */ }
						if (current?.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
							|| current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) {
							changed = true;
							throw new Error("Canvas changed on disk");
						}
					}, "loom-canvas");
				} catch (error) {
					if (changed) return null;
					throw error;
				}
			}
			return { document: next, revision: revisionOf(contents) };
		});
	}

	private async filePath(assetId: string): Promise<string> {
		const asset = typeof assetId === "string" ? await this.library.getAsset(assetId) : undefined;
		if (!asset || !isCanvasLibraryPath(asset.relativePath) || !isCanvasFile(asset.relativePath)) throw new Error("Canvas not found");
		const root = await realpath(this.library.getLibraryRoot());
		const path = await checkedPath(root, asset.relativePath, true);
		if (!(await lstat(path)).isFile()) throw new Error("Canvas is not a regular file");
		return path;
	}

	private async refreshPaths(document: CanvasDocument): Promise<CanvasDocument> {
		const ids = new Set(document.nodes.flatMap((node) => node.type === "file" && node.loom?.assetId ? [node.loom.assetId] : []));
		const assets = new Map((await Promise.all([...ids].map((id) => this.library.getAsset(id))))
			.flatMap((asset) => asset && isCanvasLibraryPath(asset.relativePath) ? [[asset.assetId, asset.relativePath] as const] : []));
		return {
			...document,
			nodes: document.nodes.map((node) => {
				const path = node.type === "file" && node.loom?.assetId && assets.get(node.loom.assetId);
				return path && path !== node.file ? { ...node, file: path } : node;
			}),
		};
	}
}

async function checkedPath(root: string, relativePath: string, file = false): Promise<string> {
	const paths = new LibraryPaths(root);
	const requested = paths.toAbsolutePath(relativePath);
	const directory = await realpath(file ? dirname(requested) : requested);
	if (directory !== root && !isCanvasLibraryPath(paths.toRelativePath(directory))) throw new Error("Canvas path is outside the library");
	return file ? resolve(directory, relativePath.split("/").at(-1)!) : directory;
}

async function readCanvasText(path: string) {
	const before = await lstat(path, { bigint: true });
	if (!before.isFile() || before.size > MAX_BYTES) throw new Error("Canvas must be a regular file up to 8 MiB");
	const text = await readFile(path, "utf8");
	return { text, before };
}
