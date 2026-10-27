import type { LocalCore, MediaJobResult } from "@loom/core";
import { normalizeImageGrade } from "@loom/core/grade";
import type { LoomTool, LoomToolResult } from "@loom/agent";

/**
 * Agent-facing FFmpeg tools. Paths are relative to the open library cwd, or absolute.
 */
export function createFfmpegTools(core: LocalCore): LoomTool[] {
	return [
		{
			name: "grade_image",
			description:
				"Grade one still image with the preview panel's controls and write a new file. " +
				"rotation is quarter-turns clockwise from 0 to 3. flipH and flipV mirror after that rotation. " +
				"crop is {x, y, w, h} from 0 to 1 of the oriented frame; omit it to keep the whole frame. " +
				"exposure is EV from -3 to 3 (0 unchanged). brightness and lightness are -1 to 1 (0 unchanged). " +
				"hue is degrees from -180 to 180 (0 unchanged). contrast is 0 to 2 and saturation is 0 to 3 (1 unchanged). " +
				"vibrance is -2 to 2 (0 unchanged). temperature is Kelvin from 1000 to 40000 (6500 unchanged). " +
				"black and white are input levels from 0 to 1 (0 and 1 unchanged). " +
				"curves maps 0..1 input to 0..1 output for rgb, r, g, and b. " +
				"lut is an optional workspace-relative .cube applied last. " +
				"JPEG, PNG, WebP, GIF, BMP, and TIFF only. GIF uses the first frame and writes PNG. " +
				"Stores the recipe on the new file. Does not create a relation: call create_relation with " +
				"fromAssetId = assetId, toAssetId = sourceAssetId, and type \"derived from\".",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					output: { type: "string" },
					rotation: { type: "integer", enum: [0, 1, 2, 3] },
					flipH: { type: "boolean" },
					flipV: { type: "boolean" },
					crop: {
						type: "object",
						properties: {
							x: { type: "number" },
							y: { type: "number" },
							w: { type: "number" },
							h: { type: "number" },
						},
						additionalProperties: false,
					},
					exposure: { type: "number" },
					brightness: { type: "number" },
					lightness: { type: "number" },
					hue: { type: "number" },
					contrast: { type: "number" },
					saturation: { type: "number" },
					vibrance: { type: "number" },
					temperature: { type: "number" },
					black: { type: "number" },
					white: { type: "number" },
					curves: {
						type: "object",
						properties: {
							rgb: curvePoints,
							r: curvePoints,
							g: curvePoints,
							b: curvePoints,
						},
						additionalProperties: false,
					},
					lut: { type: "string", description: "Workspace-relative .cube file." },
				},
				required: ["path"],
				additionalProperties: false,
			},
			execute: async (rawArgs, signal) => {
				const record = asRecord(rawArgs);
				const grade = normalizeImageGrade({
					rotation: record.rotation,
					flipH: record.flipH,
					flipV: record.flipV,
					crop: record.crop,
					exposure: record.exposure,
					brightness: record.brightness,
					lightness: record.lightness,
					hue: record.hue,
					contrast: record.contrast,
					saturation: record.saturation,
					vibrance: record.vibrance,
					temperature: record.temperature,
					black: record.black,
					white: record.white,
					curves: record.curves,
				});
				return jsonResult(await core.gradeImage({
					path: requiredPath(rawArgs, "path"),
					output: optionalPath(rawArgs, "output"),
					grade,
					lut: optionalPath(rawArgs, "lut"),
				}, signal));
			},
		},
		{
			name: "run_ffmpeg",
			description:
				"Run ffmpeg with an argv array. This is the only way to run ffmpeg: it may not be on the shell PATH, so do not look for it or call it from bash. " +
				"Use it for every media edit except still-image color grading (grade_image). " +
				"Pass args as a string array without the program name. File operands may be workspace-relative or absolute. " +
				"Write results under outputs/ unless the user names a path, and never overwrite the source file; leave out -y so an existing output is not replaced. " +
				"Examples: " +
				"extract one frame [\"-ss\", \"5\", \"-i\", \"in.mp4\", \"-frames:v\", \"1\", \"outputs/frame.jpg\"]; " +
				"cut a clip [\"-ss\", \"10\", \"-i\", \"in.mp4\", \"-t\", \"5\", \"outputs/clip.mp4\"] (add \"-c\", \"copy\" before the output to skip re-encoding); " +
				"resize with the long edge at most 720 [\"-i\", \"in.mp4\", \"-vf\", \"scale='min(720,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2\", \"outputs/small.mp4\"]; " +
				"crop to width:height:x:y [\"-i\", \"in.mp4\", \"-vf\", \"crop=320:240:16:16\", \"outputs/crop.mp4\"]; " +
				"convert format [\"-i\", \"in.mp4\", \"outputs/in.webm\"] or extract audio [\"-i\", \"in.mp4\", \"-vn\", \"outputs/in.mp3\"].",
			parameters: argvSchema,
			execute: async (rawArgs, signal) => jobResult(await core.runFfmpeg({ args: argvArg(rawArgs) }, signal)),
		},
		{
			name: "run_ffprobe",
			description:
				"Run ffprobe with an argv array and return its stdout. This is the only way to run ffprobe: it may not be on the shell PATH, so do not look for it or call it from bash. " +
				"Use it to read duration, resolution, codecs, streams, chapters, or frame counts, for example -show_format, -show_streams, -show_entries, or -count_frames. " +
				"Pass args as a string array without the program name, for example [\"-v\", \"error\", \"-of\", \"json\", \"-show_format\", \"clips/hero.mp4\"]. File operands may be workspace-relative or absolute.",
			parameters: argvSchema,
			execute: async (rawArgs, signal) => jobResult(await core.runFfprobe({ args: argvArg(rawArgs) }, signal)),
		},
	];
}

const argvSchema = {
	type: "object",
	properties: {
		args: { type: "array", items: { type: "string" } },
	},
	required: ["args"],
	additionalProperties: false,
} as const;

function argvArg(rawArgs: unknown): string[] {
	const record = asRecord(rawArgs);
	if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string")) {
		throw new TypeError("args must be an array of strings");
	}
	return record.args;
}

const curvePoints = {
	type: "array",
	items: {
		type: "object",
		properties: {
			x: { type: "number" },
			y: { type: "number" },
		},
		required: ["x", "y"],
		additionalProperties: false,
	},
};

function objectSchema(properties: Record<string, unknown>, required: string[]) {
	return { type: "object", properties, required, additionalProperties: false };
}

function jsonResult(details: unknown): LoomToolResult {
	return { content: JSON.stringify(details), details };
}

function jobResult(result: MediaJobResult): LoomToolResult {
	return jsonResult(result);
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("arguments must be an object");
	}
	return value as Record<string, unknown>;
}

function requiredPath(value: unknown, name: string): string {
	const record = asRecord(value);
	if (typeof record[name] !== "string" || !record[name].trim()) {
		throw new TypeError(`${name} must be a non-empty path`);
	}
	return record[name];
}

function optionalPath(value: unknown, name: string): string | undefined {
	const record = asRecord(value);
	if (record[name] === undefined) return undefined;
	if (typeof record[name] !== "string" || !record[name].trim()) {
		throw new TypeError(`${name} must be a non-empty path`);
	}
	return record[name];
}

function requiredNumber(value: unknown, name: string): number {
	const record = asRecord(value);
	if (typeof record[name] !== "number" || !Number.isFinite(record[name])) {
		throw new TypeError(`${name} must be a number`);
	}
	return record[name];
}

function optionalNumber(value: unknown, name: string): number | undefined {
	const record = asRecord(value);
	if (record[name] === undefined) return undefined;
	return requiredNumber(value, name);
}
