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
import { prepareFfmpegArgs, resolveLibraryPath } from "./policy.ts";
import { runMediaProcess } from "./run.ts";

export class MediaService {
	private readonly library: Library;
	private readonly run: typeof runMediaProcess;

	constructor(library: Library, run: typeof runMediaProcess = runMediaProcess) {
		this.library = library;
		this.run = run;
	}

	async getMediaInfo(relativePath: string): Promise<MediaInfoResult> {
		const input = resolveLibraryPath(relativePath, this.library.getPaths());
		const { stdout } = await this.run({
			program: "ffprobe",
			args: buildProbeArgs(input.absolutePath),
		});
		return {
			kind: "media_info",
			path: input.relativePath,
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
		const paths = this.library.getPaths();
		const prepared = prepareFfmpegArgs(input.args, paths);
		await ensureOutputParents(prepared.outputRelativePaths, paths);

		try {
			const { stdout } = await this.run({
				program,
				args: prepared.args,
				cwd: paths.root,
			});
			return {
				kind: "media_job",
				program,
				output: prepared.outputRelativePaths[0],
				outputs: prepared.outputRelativePaths,
				stdout: program === "ffprobe" ? redactLibraryPaths(stdout, paths.root) : undefined,
			};
		} catch (error) {
			throw redactError(error, paths.root);
		}
	}

	private async runConvenience(
		inputRelative: string,
		outputRelative: string | undefined,
		suffix: string,
		extension: string | undefined,
		buildArgs: (inputPath: string, outputPath: string) => string[],
	): Promise<MediaJobResult> {
		const paths = this.library.getPaths();
		const input = resolveLibraryPath(inputRelative, paths);
		const ext = extension ?? extensionOf(input.relativePath);
		const destination = outputRelative
			? resolveLibraryPath(outputRelative, paths)
			: await unusedDefaultOutput(input.relativePath, suffix, ext, paths);
		await mkdir(dirname(destination.absolutePath), { recursive: true });
		try {
			await this.run({
				program: "ffmpeg",
				args: buildArgs(input.absolutePath, destination.absolutePath),
				cwd: paths.root,
			});
			return {
				kind: "media_job",
				program: "ffmpeg",
				output: destination.relativePath,
				outputs: [destination.relativePath],
			};
		} catch (error) {
			throw redactError(error, paths.root);
		}
	}
}

async function unusedDefaultOutput(
	inputRelative: string,
	suffix: string,
	extension: string,
	paths: ReturnType<Library["getPaths"]>,
) {
	const stem = sanitizeStem(basename(inputRelative).replace(/\.[^.]+$/, "") || "output");
	const ext = extension.startsWith(".") ? extension.slice(1) : extension;
	let copyNumber = 1;
	while (true) {
		const filename = `${stem}_${suffix}${copyNumber === 1 ? "" : ` ${copyNumber}`}.${ext}`;
		const relativePath = `outputs/${filename}`;
		const resolved = resolveLibraryPath(relativePath, paths);
		try {
			await access(resolved.absolutePath);
			copyNumber += 1;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
			throw error;
		}
	}
}

async function ensureOutputParents(
	relativePaths: string[],
	paths: ReturnType<Library["getPaths"]>,
): Promise<void> {
	for (const relativePath of relativePaths) {
		const absolutePath = paths.toAbsolutePath(relativePath);
		await mkdir(dirname(absolutePath), { recursive: true });
	}
}

function extensionOf(relativePath: string): string {
	const name = basename(relativePath);
	const index = name.lastIndexOf(".");
	return index > 0 ? name.slice(index + 1) : "mp4";
}

function sanitizeStem(value: string): string {
	return (value.trim().replace(/[\\/:*?"<>|\0]+/g, "-").replace(/^\.+/, "") || "output").slice(0, 80);
}

function redactLibraryPaths(text: string, root: string): string {
	return text.split(root).join("<library>");
}

function redactError(error: unknown, root: string): Error {
	if (!(error instanceof Error)) return new Error(redactLibraryPaths(String(error), root));
	error.message = redactLibraryPaths(error.message, root);
	return error;
}
