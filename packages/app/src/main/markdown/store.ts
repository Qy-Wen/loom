import { createHash } from "node:crypto";
import { lstatSync, type BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LocalCore } from "@loom/core";
import { LibraryPaths } from "@loom/core/paths";
import { isCanvasLibraryPath } from "../../shared/canvas.ts";
import { isMarkdownFile, MARKDOWN_EDIT_LIMIT_BYTES, type MarkdownSaveResult, type MarkdownSnapshot } from "../../shared/markdown-file.ts";
import { atomicWrite } from "../storage/file.ts";
import { SerialQueue } from "../storage/serial-queue.ts";

type MarkdownLibrary = Pick<LocalCore, "getLibraryRoot" | "getAsset">;

/** How a file writes its text, so a save can put back exactly what the editor did not touch. */
interface Layout {
	bom: boolean;
	/** Line break written by the file. A file that mixes them keeps the one used most. */
	eol: "\n" | "\r\n";
}

interface Loaded {
	snapshot: MarkdownSnapshot;
	layout: Layout;
	before: BigIntStats;
}

const revisionOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Reads and saves the `.md` files of the open library for the editor.
 * Saving follows the canvas store: the caller names the revision it read, and a file that changed since
 * is reported as a conflict instead of being overwritten.
 */
export class MarkdownStore {
	private readonly writes = new SerialQueue();
	private readonly library: MarkdownLibrary;

	constructor(library: MarkdownLibrary) {
		this.library = library;
	}

	async read(assetId: string): Promise<MarkdownSnapshot> {
		return (await this.load(await this.filePath(assetId))).snapshot;
	}

	async save(assetId: string, text: unknown, expectedRevision: unknown): Promise<MarkdownSaveResult> {
		if (typeof text !== "string") throw new Error("Invalid Markdown text");
		if (typeof expectedRevision !== "string" || !/^[\da-f]{64}$/.test(expectedRevision)) throw new Error("Invalid Markdown revision");
		const root = this.library.getLibraryRoot();
		return this.writes.run(async () => {
			if (this.library.getLibraryRoot() !== root) throw new Error("The Markdown library changed");
			const path = await this.filePath(assetId);
			const current = await this.load(path);
			if (current.snapshot.revision !== expectedRevision) return { status: "conflict" };
			if (current.before.size > BigInt(MARKDOWN_EDIT_LIMIT_BYTES)) throw new Error("Markdown file exceeds 10 MiB and is read-only");
			const contents = encode(text.replace(/\r\n?/g, "\n"), current.layout);
			if (contents.byteLength > MARKDOWN_EDIT_LIMIT_BYTES) throw new Error("Markdown file exceeds 10 MiB");
			// Nothing changed: leave the file, and so its modification time, alone.
			if (revisionOf(contents) === current.snapshot.revision) return { status: "saved", snapshot: current.snapshot };
			let changed = false;
			try {
				await atomicWrite(path, contents, () => {
					let now: BigIntStats | undefined;
					try { now = lstatSync(path, { bigint: true }); } catch { /* The file left this path. */ }
					if (!now || now.dev !== current.before.dev || now.ino !== current.before.ino || now.size !== current.before.size
						|| now.mtimeNs !== current.before.mtimeNs || now.ctimeNs !== current.before.ctimeNs) {
						changed = true;
						throw new Error("Markdown changed on disk");
					}
				}, "loom-markdown");
			} catch (error) {
				if (changed) return { status: "conflict" };
				throw error;
			}
			return { status: "saved", snapshot: { text: text.replace(/\r\n?/g, "\n"), revision: revisionOf(contents), byteLength: contents.byteLength } };
		});
	}

	private async load(path: string): Promise<Loaded> {
		const before = await lstat(path, { bigint: true });
		if (!before.isFile()) throw new Error("Markdown is not a regular file");
		const bytes = await readFile(path);
		const raw = bytes.toString("utf8");
		const bom = raw.charCodeAt(0) === 0xfeff;
		const body = bom ? raw.slice(1) : raw;
		const crlf = (body.match(/\r\n/g) ?? []).length;
		const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
		const layout: Layout = { bom, eol: crlf > lf ? "\r\n" : "\n" };
		return { snapshot: { text: body.replace(/\r\n?/g, "\n"), revision: revisionOf(bytes), byteLength: bytes.byteLength }, layout, before };
	}

	private async filePath(assetId: string): Promise<string> {
		const asset = typeof assetId === "string" ? await this.library.getAsset(assetId) : undefined;
		if (!asset || !isCanvasLibraryPath(asset.relativePath) || !isMarkdownFile(asset.relativePath)) throw new Error("Markdown file not found");
		const root = await realpath(this.library.getLibraryRoot());
		const requested = new LibraryPaths(root).toAbsolutePath(asset.relativePath);
		const directory = await realpath(dirname(requested));
		if (directory !== root && !isCanvasLibraryPath(new LibraryPaths(root).toRelativePath(directory))) throw new Error("Markdown path is outside the library");
		return resolve(directory, asset.relativePath.split("/").at(-1)!);
	}
}

function encode(text: string, layout: Layout): Buffer {
	const body = layout.eol === "\n" ? text : text.replaceAll("\n", layout.eol);
	return Buffer.from(layout.bom ? `\uFEFF${body}` : body, "utf8");
}
