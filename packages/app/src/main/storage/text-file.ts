import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstatSync, type BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LocalCore } from "@loom/core";
import { LibraryPaths } from "@loom/core/paths";
import { isCanvasLibraryPath } from "../../shared/canvas.ts";
import { isMarkdownFile } from "../../shared/markdown-file.ts";
import { isHtmlFile, TEXT_FILE_EDIT_LIMIT_BYTES, type TextFileSaveResult, type TextFileSnapshot } from "../../shared/text-file.ts";
import { atomicWrite } from "./file.ts";
import { SerialQueue } from "./serial-queue.ts";

type TextFileLibrary = Pick<LocalCore, "getLibraryRoot" | "getAsset">;
type TextFileFormat = "Markdown" | "HTML";
const supports = { Markdown: isMarkdownFile, HTML: isHtmlFile };

/** How a file writes its text, so a save can put back exactly what the editor did not touch. */
interface Layout {
	bom: boolean;
	/** Line break written by the file. A file that mixes them keeps the one used most. */
	eol: "\n" | "\r\n";
}

interface Loaded {
	snapshot: TextFileSnapshot;
	layout: Layout;
	before: BigIntStats;
}

const revisionOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Reads and saves one type of editable text file from the open library.
 * Saving follows the canvas store: the caller names the revision it read, and a file that changed since
 * is reported as a conflict instead of being overwritten.
 */
export class TextFileStore {
	private readonly writes = new SerialQueue();
	private readonly library: TextFileLibrary;
	private readonly format: TextFileFormat;

	constructor(library: TextFileLibrary, format: TextFileFormat) {
		this.library = library;
		this.format = format;
	}

	async read(assetId: string, maxBytes?: number): Promise<TextFileSnapshot> {
		return (await this.load(await this.filePath(assetId), maxBytes)).snapshot;
	}

	async save(assetId: string, text: unknown, expectedRevision: unknown): Promise<TextFileSaveResult> {
		if (typeof text !== "string") throw new Error(`Invalid ${this.format} text`);
		if (typeof expectedRevision !== "string" || !/^[\da-f]{64}$/.test(expectedRevision)) throw new Error(`Invalid ${this.format} revision`);
		const root = this.library.getLibraryRoot();
		return this.writes.run(async () => {
			if (this.library.getLibraryRoot() !== root) throw new Error(`The ${this.format} library changed`);
			const path = await this.filePath(assetId);
			const current = await this.load(path);
			if (current.snapshot.revision !== expectedRevision) return { status: "conflict" };
			if (current.before.size > BigInt(TEXT_FILE_EDIT_LIMIT_BYTES)) throw new Error(`${this.format} file exceeds 10 MiB and is read-only`);
			const contents = encode(text.replace(/\r\n?/g, "\n"), current.layout);
			if (contents.byteLength > TEXT_FILE_EDIT_LIMIT_BYTES) throw new Error(`${this.format} file exceeds 10 MiB`);
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
						throw new Error(`${this.format} changed on disk`);
					}
				}, `loom-${this.format.toLowerCase()}`);
			} catch (error) {
				if (changed) return { status: "conflict" };
				throw error;
			}
			return { status: "saved", snapshot: { text: text.replace(/\r\n?/g, "\n"), revision: revisionOf(contents), byteLength: contents.byteLength } };
		});
	}

	private async load(path: string, maxBytes?: number): Promise<Loaded> {
		const before = await lstat(path, { bigint: true });
		if (!before.isFile()) throw new Error(`${this.format} is not a regular file`);
		if (maxBytes !== undefined && before.size > BigInt(maxBytes)) throw new Error(`${this.format} file exceeds the preview size limit`);
		const bytes = await readFile(path);
		if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new Error(`${this.format} file exceeds the preview size limit`);
		if (this.format === "HTML" && !isUtf8(bytes)) throw new Error("HTML source must be encoded as UTF-8 to edit it");
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
		if (!asset || !isCanvasLibraryPath(asset.relativePath) || !supports[this.format](asset.relativePath)) throw new Error(`${this.format} file not found`);
		const root = await realpath(this.library.getLibraryRoot());
		const requested = new LibraryPaths(root).toAbsolutePath(asset.relativePath);
		const directory = await realpath(dirname(requested));
		if (directory !== root && !isCanvasLibraryPath(new LibraryPaths(root).toRelativePath(directory))) throw new Error(`${this.format} path is outside the library`);
		return resolve(directory, asset.relativePath.split("/").at(-1)!);
	}
}

function encode(text: string, layout: Layout): Buffer {
	const body = layout.eol === "\n" ? text : text.replaceAll("\n", layout.eol);
	return Buffer.from(layout.bom ? `\uFEFF${body}` : body, "utf8");
}
