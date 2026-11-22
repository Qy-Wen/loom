import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { retryWindowsFileOperation } from "../fs-retry.ts";
import {
	buildGradeImageArgs,
	buildGradeVideoArgs,
	buildImageGradeFilter,
	gradeExportExtension,
	gradeSiblingRelative,
	gradeVideoSiblingRelative,
	isGradeableImage,
	isGradeableVideo,
	normalizeImageGrade,
	type ImageGrade,
} from "../grade/index.ts";
import { buildGradeImageReplacementArgs, buildGradeVideoReplacementArgs } from "../grade/filters.ts";
import type { Library } from "../library/library.ts";
import type {
	GradeImageArgs,
	GradeVideoArgs,
	MediaInfoResult,
	PreviewVideoGradeArgs,
	MediaJobResult,
	RunFfmpegArgs,
	RunFfprobeArgs,
} from "../model/media.ts";
import { buildProbeArgs } from "./operations.ts";
import { parseFfprobeJson } from "./probe.ts";
import { prepareFfmpegArgs, resolveMediaPath } from "./policy.ts";
import { runMediaProcess } from "./run.ts";
import { GradePreview } from "./grade-preview.ts";

export class MediaService {
	private readonly library: Library;
	private readonly run: typeof runMediaProcess;
	private readonly previews = new GradePreview();
	private readonly replacingGrades = new Set<string>();

	constructor(library: Library, run: typeof runMediaProcess = runMediaProcess) {
		this.library = library;
		this.run = run;
	}

	async getMediaInfo(path: string, signal?: AbortSignal): Promise<MediaInfoResult> {
		const cwd = this.cwd();
		const input = resolveMediaPath(path, cwd);
		const { stdout } = await this.run({
			program: "ffprobe",
			args: buildProbeArgs(input.absolutePath),
			cwd,
			signal,
		});
		return {
			kind: "media_info",
			path: input.path,
			...parseFfprobeJson(stdout),
		};
	}

	async gradeImage(
		args: GradeImageArgs,
		signal?: AbortSignal,
	): Promise<{ input: string; output: string }> {
		const prepared = this.prepareGrade(args);
		if (!prepared.filter) throw new TypeError("Grade does not change the image");
		if (args.overwriteOriginal) {
			return this.replaceGrade(prepared.input.absolutePath, prepared.filter, buildGradeImageReplacementArgs, signal);
		}
		const cwd = this.cwd();
		const destination = args.output
			? resolveMediaPath(args.output, cwd)
			: args.beside
				? await unusedSiblingOutput(prepared.input.path, cwd)
				: await unusedDefaultOutput(prepared.input.path, "grade", gradedExtension(prepared.input.path), cwd);
		await mkdir(dirname(destination.absolutePath), { recursive: true });
		await this.run({
			program: "ffmpeg",
			args: buildGradeImageArgs(prepared.input.absolutePath, destination.absolutePath, prepared.filter, false),
			cwd,
			signal,
		});
		return { input: prepared.input.path, output: destination.path };
	}

	async gradeVideo(
		args: GradeVideoArgs,
		signal?: AbortSignal,
	): Promise<{ input: string; output: string }> {
		const prepared = this.prepareVideoGrade(args);
		if (!prepared.filter) throw new TypeError("Grade does not change the video");
		if (args.overwriteOriginal) {
			return this.replaceGrade(prepared.input.absolutePath, prepared.filter, buildGradeVideoReplacementArgs, signal, 2 * 60 * 60_000);
		}
		const cwd = this.cwd();
		const info = await this.getMediaInfo(prepared.input.path, signal);
		const destination = args.output
			? resolveMediaPath(args.output, cwd)
			: args.beside
				? await unusedSiblingOutput(prepared.input.path, cwd, true)
				: await unusedDefaultOutput(prepared.input.path, "grade", "mp4", cwd);
		await mkdir(dirname(destination.absolutePath), { recursive: true });
		await this.run({
			program: "ffmpeg",
			args: buildGradeVideoArgs(prepared.input.absolutePath, destination.absolutePath, prepared.filter, info.audioCodec),
			cwd,
			signal,
			timeoutMs: 2 * 60 * 60_000,
		});
		return { input: prepared.input.path, output: destination.path };
	}

	private async replaceGrade(
		input: string,
		filter: string,
		buildArgs: (input: string, output: string, filter: string, format?: string) => string[],
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<{ input: string; output: string }> {
		const paths = this.library.getPaths();
		const path = paths.toRelativePath(input);
		const original = await lstat(input, { bigint: true });
		if (!original.isFile() || paths.isIgnoredPath(input)) throw new Error("Grade source must be a library file");
		const [root, source] = await Promise.all([realpath(paths.root), realpath(input)]);
		const sourcePath = relative(root, source);
		if (isAbsolute(sourcePath) || sourcePath === ".." || sourcePath.startsWith(`..${sep}`)
			|| paths.isIgnoredPath(join(paths.root, sourcePath))) {
			throw new Error("Grade source must be a library file");
		}
		if (this.replacingGrades.has(source)) throw new Error("A save is already in progress for this file");
		this.replacingGrades.add(source);

		const output = join(dirname(source), `.loom-grade.${randomUUID()}.tmp${extname(source)}`);
		let staged = false;
		try {
			const handle = await open(output, "wx", 0o600);
			staged = true;
			await handle.close();
			const info = await this.getMediaInfo(source, signal);
			await this.run({ program: "ffmpeg", args: buildArgs(source, output, filter, info.format), cwd: paths.root, signal, timeoutMs });
			if ((await stat(output)).size === 0) throw new Error("Grade produced an empty file");
			await chmod(output, Number(original.mode & 0o777n));
			await retryWindowsFileOperation(async () => {
				const current = await lstat(input, { bigint: true });
				if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size
					|| current.mtimeNs !== original.mtimeNs || current.ctimeNs !== original.ctimeNs) {
					throw new Error("The source file changed during saving. Try again.");
				}
				signal?.throwIfAborted();
				await rename(output, source);
			});
			staged = false;
			return { input: path, output: path };
		} finally {
			this.replacingGrades.delete(source);
			if (staged) await retryWindowsFileOperation(() => rm(output, { force: true })).catch(() => undefined);
		}
	}

	async previewVideoGrade(args: PreviewVideoGradeArgs, signal?: AbortSignal, force = false): Promise<Buffer | null> {
		const prepared = this.prepareVideoGrade(args);
		if (!prepared.filter && !force) return null;
		return this.previews.render(prepared.input.absolutePath, prepared.filter, this.cwd(), signal, clampGradeTime(args.timeSeconds));
	}

	async previewImageGrade(args: GradeImageArgs, signal?: AbortSignal, force = false): Promise<Buffer | null> {
		const prepared = this.prepareGrade(args);
		if (!prepared.filter && !force) return null;
		return this.previews.render(prepared.input.absolutePath, prepared.filter, this.cwd(), signal);
	}

	async runFfmpeg(input: RunFfmpegArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		const cwd = this.cwd();
		const prepared = prepareFfmpegArgs(input.args, cwd);
		await ensureOutputParents(prepared.outputPaths, cwd);
		await this.run({
			program: "ffmpeg",
			args: prepared.args,
			cwd,
			signal,
		});
		return {
			kind: "media_job",
			program: "ffmpeg",
			output: prepared.outputPaths[0],
			outputs: prepared.outputPaths,
		};
	}

	/** Read-only: path operands resolve against the library, and nothing is created. */
	async runFfprobe(input: RunFfprobeArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		const { args } = prepareFfmpegArgs(input.args, this.cwd());
		const { stdout } = await this.run({
			program: "ffprobe",
			args,
			cwd: this.cwd(),
			signal,
		});
		return { kind: "media_job", program: "ffprobe", stdout };
	}

	private cwd(): string {
		return this.library.getPaths().root;
	}

	private prepareGrade(args: GradeImageArgs): { input: { path: string; absolutePath: string }; filter: string | null; grade: ImageGrade; lut?: string } {
		const cwd = this.cwd();
		const input = resolveMediaPath(args.path, cwd);
		if (!isGradeableImage(input.path)) {
			throw new TypeError("Grade supports JPEG, PNG, WebP, GIF, BMP, and TIFF");
		}
		const grade = normalizeImageGrade(args.grade);
		const lut = this.resolveLut(args.lut);
		return { input, grade, lut: lut?.path, filter: buildImageGradeFilter(grade, lut?.absolutePath) };
	}

	private prepareVideoGrade(args: GradeVideoArgs | PreviewVideoGradeArgs): { input: { path: string; absolutePath: string }; filter: string | null; grade: ImageGrade; lut?: string } {
		const cwd = this.cwd();
		const input = resolveMediaPath(args.path, cwd);
		if (!isGradeableVideo(input.path)) {
			throw new TypeError("Grade supports MP4, MOV, MKV, WebM, M4V, and AVI");
		}
		const grade = normalizeImageGrade(args.grade);
		const lut = this.resolveLut(args.lut);
		return { input, grade, lut: lut?.path, filter: buildImageGradeFilter(grade, lut?.absolutePath) };
	}

	/** Drop decoded frames when the library closes or changes. */
	releasePreviews(): void {
		this.previews.clear();
	}

	private resolveLut(lut: string | undefined): { path: string; absolutePath: string } | undefined {
		if (!lut?.trim()) return undefined;
		const resolved = resolveMediaPath(lut, this.cwd());
		if (!resolved.path.toLowerCase().endsWith(".cube")) throw new TypeError("lut must be a .cube file");
		const path = this.library.getPaths().toRelativePath(resolved.absolutePath);
		return { path, absolutePath: resolved.absolutePath };
	}
}

function clampGradeTime(value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError("timeSeconds must be a non-negative finite number");
	}
	return value;
}

async function unusedSiblingOutput(inputPath: string, cwd: string, video = false) {
	for (let copy = 1; copy < 1000; copy += 1) {
		const resolved = resolveMediaPath(video ? gradeVideoSiblingRelative(inputPath, copy) : gradeSiblingRelative(inputPath, copy), cwd);
		if (resolved.absolutePath === resolveMediaPath(inputPath, cwd).absolutePath) continue;
		try {
			await access(resolved.absolutePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
			throw error;
		}
	}
	throw new Error("Could not choose a grade filename");
}

async function unusedDefaultOutput(inputPath: string, suffix: string, extension: string, cwd: string) {
	const stem = sanitizeStem(basename(inputPath).replace(/\.[^.]+$/, "") || "output");
	const ext = extension.startsWith(".") ? extension.slice(1) : extension;
	let copyNumber = 1;
	while (true) {
		const filename = `${stem}_${suffix}${copyNumber === 1 ? "" : ` ${copyNumber}`}.${ext}`;
		const resolved = resolveMediaPath(`outputs/${filename}`, cwd);
		try {
			await access(resolved.absolutePath);
			copyNumber += 1;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
			throw error;
		}
	}
}

async function ensureOutputParents(paths: string[], cwd: string): Promise<void> {
	for (const path of paths) {
		await mkdir(dirname(resolveMediaPath(path, cwd).absolutePath), { recursive: true });
	}
}

function gradedExtension(path: string): string {
	return gradeExportExtension(extensionOf(path));
}

function extensionOf(path: string): string {
	const name = basename(path);
	const index = name.lastIndexOf(".");
	return index > 0 ? name.slice(index + 1) : "mp4";
}

function sanitizeStem(value: string): string {
	return (value.trim().replace(/[\\/:*?"<>|\0]+/g, "-").replace(/^\.+/, "") || "output").slice(0, 80);
}
