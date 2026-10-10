import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	buildGradeImageArgs,
	buildImageGradeFilter,
	gradeExportExtension,
	gradeSiblingRelative,
	isGradeableImage,
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
	MediaInfoResult,
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

	async previewImageGrade(args: GradeImageArgs, signal?: AbortSignal, force = false): Promise<Buffer | null> {
		const prepared = this.prepareGrade(args);
		if (!prepared.filter && !force) return null;
		const file = join(this.library.getPaths().cache, "grade-preview", `${randomUUID()}.jpg`);
		await mkdir(dirname(file), { recursive: true });
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

async function unusedSiblingOutput(inputPath: string, cwd: string) {
	for (let copy = 1; copy < 1000; copy += 1) {
		const resolved = resolveMediaPath(gradeSiblingRelative(inputPath, copy), cwd);
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
