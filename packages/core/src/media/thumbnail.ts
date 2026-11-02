import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { extname, join } from "node:path";
import { retryWindowsFileOperation } from "../fs-retry.ts";
import type { LibraryPaths } from "../library/paths.ts";
import type { Asset } from "../model/asset.ts";
import { buildThumbnailArgs } from "./operations.ts";
import { runMediaProcess } from "./run.ts";

export const THUMBNAIL_SIZE = 256;
const MAX_CONCURRENT = 3;
/** Video frames are taken a little after the start; the very first frame is often black. */
const VIDEO_SEEK_SECONDS = 0.1;
/** ffmpeg has no SVG decoder. The renderer falls back to the original file. */
const UNSUPPORTED = new Set([".svg"]);
const SUFFIX = ".webp";

export interface ThumbnailSource {
	getAsset(assetId: string): Promise<Asset | undefined>;
	getPaths(): LibraryPaths;
}

/**
 * Small previews cached under `.loom/thumbnails/<assetId>.webp`, shared by every view that shows a thumbnail.
 * Each file is stamped with the source's mtime, so it is current exactly while the two match.
 */
export class ThumbnailService {
	private readonly source: ThumbnailSource;
	private readonly run: typeof runMediaProcess;
	private readonly jobs = new Map<string, Promise<string | undefined>>();
	/** Versions ffmpeg could not decode, so a broken file is not retried on every request. */
	private readonly failed = new Set<string>();
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(source: ThumbnailSource, run: typeof runMediaProcess = runMediaProcess) {
		this.source = source;
		this.run = run;
	}

	/** Absolute path of the current thumbnail, generated on first use. Undefined when the asset has none. */
	async get(assetId: string, signal?: AbortSignal): Promise<string | undefined> {
		const asset = await this.source.getAsset(assetId);
		if (!asset || !isThumbnailable(asset)) return undefined;
		const paths = this.source.getPaths();
		const file = join(paths.thumbnails, `${asset.assetId}${SUFFIX}`);
		const version = `${asset.assetId}:${asset.modifiedAt}:${asset.size}`;
		if (this.failed.has(version)) return undefined;
		if (await isFresh(file, asset.modifiedAt)) return file;
		let job = this.jobs.get(version);
		if (!job) {
			job = this.generate(asset, paths, file, version, signal).finally(() => this.jobs.delete(version));
			this.jobs.set(version, job);
		}
		return job;
	}

	async forget(assetId: string): Promise<void> {
		await rm(join(this.source.getPaths().thumbnails, `${assetId}${SUFFIX}`), { force: true }).catch(() => undefined);
	}

	/** Drop thumbnails whose asset is gone, and temp files left by a crash. */
	async prune(assetIds: Iterable<string>): Promise<void> {
		this.failed.clear();
		const keep = new Set(assetIds);
		const dir = this.source.getPaths().thumbnails;
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const orphan = name.endsWith(SUFFIX) ? !keep.has(name.slice(0, -SUFFIX.length)) : this.jobs.size === 0;
			if (orphan) await rm(join(dir, name), { force: true }).catch(() => undefined);
		}
	}

	private async generate(
		asset: Asset,
		paths: LibraryPaths,
		file: string,
		version: string,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const temp = join(paths.thumbnails, `${asset.assetId}.${randomUUID()}.tmp`);
		try {
			await this.slot(async () => {
				await mkdir(paths.thumbnails, { recursive: true });
				await this.render(paths.toAbsolutePath(asset.relativePath), temp, asset.type, paths.root, signal);
			});
			const stamp = new Date(asset.modifiedAt);
			await utimes(temp, stamp, stamp);
			await retryWindowsFileOperation(() => rename(temp, file));
			return file;
		} catch (error) {
			if (signal?.aborted) throw error;
			this.failed.add(version);
			return undefined;
		} finally {
			await rm(temp, { force: true }).catch(() => undefined);
		}
	}

	private async render(input: string, output: string, type: Asset["type"], cwd: string, signal?: AbortSignal): Promise<void> {
		const seeks = type === "video" ? [VIDEO_SEEK_SECONDS, undefined] : [undefined];
		let failure: unknown;
		for (const seek of seeks) {
			try {
				await this.run({
					program: "ffmpeg",
					args: buildThumbnailArgs(input, output, THUMBNAIL_SIZE, seek),
					cwd,
					signal,
					timeoutMs: 30_000,
				});
				// A seek past the end of a short clip exits cleanly without writing a frame.
				if ((await stat(output)).size > 0) return;
				failure = new Error("ffmpeg wrote no frame");
			} catch (error) {
				if (signal?.aborted) throw error;
				failure = error;
			}
		}
		throw failure;
	}

	/** At most MAX_CONCURRENT ffmpeg processes. A finished job hands its slot straight to the next waiter. */
	private async slot<T>(work: () => Promise<T>): Promise<T> {
		if (this.active < MAX_CONCURRENT) this.active += 1;
		else await new Promise<void>((resolve) => this.waiting.push(resolve));
		try {
			return await work();
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active -= 1;
		}
	}
}

export function isThumbnailable(asset: Pick<Asset, "type" | "filename">): boolean {
	return (asset.type === "image" || asset.type === "video") && !UNSUPPORTED.has(extname(asset.filename).toLowerCase());
}

async function isFresh(file: string, modifiedAt: number): Promise<boolean> {
	try {
		const info = await stat(file);
		return info.size > 0 && Math.abs(info.mtimeMs - modifiedAt) < 2;
	} catch {
		return false;
	}
}
