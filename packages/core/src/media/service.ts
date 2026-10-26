import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	buildGradeImageArgs,
	buildGradeVideoArgs,
	buildGradeVideoFrameArgs,
	buildImageGradeFilter,
	gradeExportExtension,
	gradeSiblingRelative,
	gradeVideoSiblingRelative,
	isGradeableImage,
	isGradeableVideo,
	normalizeImageGrade,
	type ImageGrade,
} from "../grade/index.ts";
import type { Library } from "../library/library.ts";
import type {
	ConvertFormatArgs,
	CropVideoArgs,
	ExtractClipArgs,
	ExtractFrameArgs,
	GradeImageArgs,
	GradeVideoArgs,
	MediaInfoResult,
	PreviewVideoGradeArgs,
	MediaJobResult,
	ResizeVideoArgs,
	RunFfmpegArgs,
} from "../model/media.ts";
import type { MediaProgram } from "./binaries.ts";
import {
	assertFiniteNumber,
	buildConvertArgs,
	buildCropArgs,
	buildExtractClipArgs,
	buildExtractFrameArgs,
	buildProbeArgs,
	buildResizeArgs,
	normalizeConvertFormat,
} from "./operations.ts";
import { parseFfprobeJson } from "./probe.ts";
import { prepareFfmpegArgs, resolveMediaPath } from "./policy.ts";
import { runMediaProcess } from "./run.ts";

export class MediaService {
	private readonly library: Library;
	private readonly run: typeof runMediaProcess;
	/** One decoded preview frame per source, so a slider move does not seek again. */
	private readonly gradeFrames = new Map<string, { timeMs: number; file: string }>();
	/** Private scratch directory under the OS temp dir, so a crash never leaves files in the library. Created on first use. */
	private scratch: Promise<string> | undefined;

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

	async extractFrame(args: ExtractFrameArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		const timeSeconds = assertFiniteNumber(args.timeSeconds, "timeSeconds");
		return this.runConvenience(args.path, args.output, "extract_frame", "jpg", (input, output) => {
			return buildExtractFrameArgs(input, output, timeSeconds);
		}, signal);
	}

	async extractClip(args: ExtractClipArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		const startSeconds = assertFiniteNumber(args.startSeconds, "startSeconds");
		const durationSeconds = assertFiniteNumber(args.durationSeconds, "durationSeconds");
		if (durationSeconds <= 0) throw new TypeError("durationSeconds must be greater than 0");
		return this.runConvenience(args.path, args.output, "extract_clip", undefined, (input, output) => {
			return buildExtractClipArgs(input, output, startSeconds, durationSeconds);
		}, signal);
	}

	async resizeVideo(args: ResizeVideoArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		if (args.width !== undefined) assertFiniteNumber(args.width, "width");
		if (args.height !== undefined) assertFiniteNumber(args.height, "height");
		if (args.maxEdge !== undefined) assertFiniteNumber(args.maxEdge, "maxEdge");
		return this.runConvenience(args.path, args.output, "resize", undefined, (input, output) => {
			return buildResizeArgs(input, output, args);
		}, signal);
	}

	async cropVideo(args: CropVideoArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		const crop = {
			x: assertFiniteNumber(args.x, "x"),
			y: assertFiniteNumber(args.y, "y"),
			width: assertFiniteNumber(args.width, "width"),
			height: assertFiniteNumber(args.height, "height"),
		};
		if (crop.width < 2 || crop.height < 2) throw new TypeError("crop width and height must be at least 2");
		return this.runConvenience(args.path, args.output, "crop", undefined, (input, output) => {
			return buildCropArgs(input, output, crop);
		}, signal);
	}

	async gradeImage(
		args: GradeImageArgs,
		signal?: AbortSignal,
	): Promise<{ input: string; output: string; grade: ImageGrade; lut?: string }> {
		const prepared = this.prepareGrade(args);
		if (!prepared.filter) throw new TypeError("Grade does not change the image");
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
		return { input: prepared.input.path, output: destination.path, grade: prepared.grade, lut: prepared.lut };
	}

	async gradeVideo(
		args: GradeVideoArgs,
		signal?: AbortSignal,
	): Promise<{ input: string; output: string; grade: ImageGrade; lut?: string }> {
		const prepared = this.prepareVideoGrade(args);
		if (!prepared.filter) throw new TypeError("Grade does not change the video");
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
		return { input: prepared.input.path, output: destination.path, grade: prepared.grade, lut: prepared.lut };
	}

	async previewVideoGrade(args: PreviewVideoGradeArgs, signal?: AbortSignal, force = false): Promise<Buffer | null> {
		const prepared = this.prepareVideoGrade(args);
		if (!prepared.filter && !force) return null;
		const timeSeconds = clampGradeTime(args.timeSeconds);
		const frame = await this.gradeFrame(prepared.input.absolutePath, timeSeconds, signal);
		if (!prepared.filter) return readFile(frame);
		return this.previewImageGrade({
			path: frame,
			grade: args.grade,
			lut: args.lut,
		}, signal, force);
	}

	async previewImageGrade(args: GradeImageArgs, signal?: AbortSignal, force = false): Promise<Buffer | null> {
		const prepared = this.prepareGrade(args);
		if (!prepared.filter && !force) return null;
		const file = join(await this.scratchDir("preview"), `${randomUUID()}.jpg`);
		try {
			await this.run({
				program: "ffmpeg",
				args: buildGradeImageArgs(prepared.input.absolutePath, file, prepared.filter, true),
				cwd: this.cwd(),
				signal,
				timeoutMs: 30_000,
			});
			return await readFile(file);
		} finally {
			await rm(file, { force: true }).catch(() => undefined);
		}
	}

	async convertFormat(args: ConvertFormatArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		const format = normalizeConvertFormat(args.format);
		return this.runConvenience(args.path, args.output, "convert", format, (input, output) => {
			return buildConvertArgs(input, output);
		}, signal);
	}

	async runFfmpeg(input: RunFfmpegArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		const program: MediaProgram = input.program ?? "ffmpeg";
		if (program !== "ffmpeg" && program !== "ffprobe") {
			throw new TypeError("program must be ffmpeg or ffprobe");
		}
		const cwd = this.cwd();
		const prepared = prepareFfmpegArgs(input.args, cwd);
		await ensureOutputParents(prepared.outputPaths, cwd);
		const { stdout } = await this.run({
			program,
			args: prepared.args,
			cwd,
			signal,
		});
		return {
			kind: "media_job",
			program,
			output: prepared.outputPaths[0],
			outputs: prepared.outputPaths,
			stdout: program === "ffprobe" ? stdout : undefined,
		};
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

	private async gradeFrame(absolutePath: string, timeSeconds: number, signal?: AbortSignal): Promise<string> {
		const timeMs = Math.round(timeSeconds * 1000);
		const hit = this.gradeFrames.get(absolutePath);
		if (hit?.timeMs === timeMs) return hit.file;
		const file = join(await this.scratchDir("frames"), `${randomUUID()}.jpg`);
		try {
			await this.run({
				program: "ffmpeg",
				args: buildGradeVideoFrameArgs(absolutePath, file, timeSeconds),
				cwd: this.cwd(),
				signal,
				timeoutMs: 30_000,
			});
		} catch (error) {
			await rm(file, { force: true }).catch(() => undefined);
			throw error;
		}
		const previous = this.gradeFrames.get(absolutePath);
		this.gradeFrames.set(absolutePath, { timeMs, file });
		if (previous) await rm(previous.file, { force: true }).catch(() => undefined);
		this.forgetOldGradeFrames(absolutePath);
		return file;
	}

	private async scratchDir(name: "preview" | "frames"): Promise<string> {
		this.scratch ??= mkdtemp(join(tmpdir(), "loom-grade-"));
		const root = await this.scratch.catch((error) => { this.scratch = undefined; throw error; });
		const dir = join(root, name);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	/** Remove the scratch directory and forget cached frames. A later preview creates a new one. */
	async releaseScratch(): Promise<void> {
		const scratch = this.scratch;
		this.scratch = undefined;
		this.gradeFrames.clear();
		if (!scratch) return;
		const root = await scratch.catch(() => undefined);
		if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}

	private forgetOldGradeFrames(keep: string): void {
		while (this.gradeFrames.size > 4) {
			const oldest = [...this.gradeFrames.keys()].find((path) => path !== keep);
			if (!oldest) return;
			const frame = this.gradeFrames.get(oldest);
			this.gradeFrames.delete(oldest);
			if (frame) void rm(frame.file, { force: true }).catch(() => undefined);
		}
	}

	private resolveLut(lut: string | undefined): { path: string; absolutePath: string } | undefined {
		if (!lut?.trim()) return undefined;
		const resolved = resolveMediaPath(lut, this.cwd());
		if (!resolved.path.toLowerCase().endsWith(".cube")) throw new TypeError("lut must be a .cube file");
		const path = this.library.getPaths().toRelativePath(resolved.absolutePath);
		return { path, absolutePath: resolved.absolutePath };
	}

	private async runConvenience(
		inputPath: string,
		outputPath: string | undefined,
		suffix: string,
		extension: string | undefined,
		buildArgs: (inputPath: string, outputPath: string) => string[],
		signal?: AbortSignal,
	): Promise<MediaJobResult> {
		const cwd = this.cwd();
		const input = resolveMediaPath(inputPath, cwd);
		const ext = extension ?? extensionOf(input.path);
		const destination = outputPath
			? resolveMediaPath(outputPath, cwd)
			: await unusedDefaultOutput(input.path, suffix, ext, cwd);
		await mkdir(dirname(destination.absolutePath), { recursive: true });
		await this.run({
			program: "ffmpeg",
			args: buildArgs(input.absolutePath, destination.absolutePath),
			cwd,
			signal,
		});
		return {
			kind: "media_job",
			program: "ffmpeg",
			output: destination.path,
			outputs: [destination.path],
		};
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
