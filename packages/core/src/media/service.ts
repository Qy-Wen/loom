import { access, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Library } from "../library/library.ts";
import type {
	ConvertFormatArgs,
	CropVideoArgs,
	ExtractClipArgs,
	ExtractFrameArgs,
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

	async getMediaInfo(path: string): Promise<MediaInfoResult> {
		const cwd = this.cwd();
		const input = resolveMediaPath(path, cwd);
		const { stdout } = await this.run({
			program: "ffprobe",
			args: buildProbeArgs(input.absolutePath),
			cwd,
		});
		return {
			kind: "media_info",
			path: input.path,
			...parseFfprobeJson(stdout),
		};
	}

	async extractFrame(args: ExtractFrameArgs): Promise<MediaJobResult> {
		const timeSeconds = assertFiniteNumber(args.timeSeconds, "timeSeconds");
		return this.runConvenience(args.path, args.output, "extract_frame", "jpg", (input, output) => {
			return buildExtractFrameArgs(input, output, timeSeconds);
		});
	}

	async extractClip(args: ExtractClipArgs): Promise<MediaJobResult> {
		const startSeconds = assertFiniteNumber(args.startSeconds, "startSeconds");
		const durationSeconds = assertFiniteNumber(args.durationSeconds, "durationSeconds");
		if (durationSeconds <= 0) throw new TypeError("durationSeconds must be greater than 0");
		return this.runConvenience(args.path, args.output, "extract_clip", undefined, (input, output) => {
			return buildExtractClipArgs(input, output, startSeconds, durationSeconds);
		});
	}

	async resizeVideo(args: ResizeVideoArgs): Promise<MediaJobResult> {
		if (args.width !== undefined) assertFiniteNumber(args.width, "width");
		if (args.height !== undefined) assertFiniteNumber(args.height, "height");
		if (args.maxEdge !== undefined) assertFiniteNumber(args.maxEdge, "maxEdge");
		return this.runConvenience(args.path, args.output, "resize", undefined, (input, output) => {
			return buildResizeArgs(input, output, args);
		});
	}

	async cropVideo(args: CropVideoArgs): Promise<MediaJobResult> {
		const crop = {
			x: assertFiniteNumber(args.x, "x"),
			y: assertFiniteNumber(args.y, "y"),
			width: assertFiniteNumber(args.width, "width"),
			height: assertFiniteNumber(args.height, "height"),
		};
		if (crop.width < 2 || crop.height < 2) throw new TypeError("crop width and height must be at least 2");
		return this.runConvenience(args.path, args.output, "crop", undefined, (input, output) => {
			return buildCropArgs(input, output, crop);
		});
	}

	async convertFormat(args: ConvertFormatArgs): Promise<MediaJobResult> {
		const format = normalizeConvertFormat(args.format);
		return this.runConvenience(args.path, args.output, "convert", format, (input, output) => {
			return buildConvertArgs(input, output);
		});
	}

	async runFfmpeg(input: RunFfmpegArgs): Promise<MediaJobResult> {
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

	private async runConvenience(
		inputPath: string,
		outputPath: string | undefined,
		suffix: string,
		extension: string | undefined,
		buildArgs: (inputPath: string, outputPath: string) => string[],
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
		});
		return {
			kind: "media_job",
			program: "ffmpeg",
			output: destination.path,
			outputs: [destination.path],
		};
	}
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

function extensionOf(path: string): string {
	const name = basename(path);
	const index = name.lastIndexOf(".");
	return index > 0 ? name.slice(index + 1) : "mp4";
}

function sanitizeStem(value: string): string {
	return (value.trim().replace(/[\\/:*?"<>|\0]+/g, "-").replace(/^\.+/, "") || "output").slice(0, 80);
}
