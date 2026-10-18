import type { LocalCore, MediaJobResult } from "@loom/core";
import { normalizeImageGrade } from "@loom/core/grade";
import type { LoomTool, LoomToolResult } from "@loom/agent";

/**
 * Agent-facing FFmpeg tools. Paths are relative to the open library cwd, or absolute.
 */
export function createFfmpegTools(core: LocalCore): LoomTool[] {
	return [
		{
			name: "get_media_info",
			description:
				"Read duration, resolution, codecs, and format for one media file. " +
				"Pass a path relative to the workspace cwd, such as clips/hero.mp4, or an absolute path. " +
				"Prefer this over run_ffmpeg for inspection.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative or absolute path." },
				},
				required: ["path"],
				additionalProperties: false,
			},
			execute: async (rawArgs, signal) => {
				const path = requiredPath(rawArgs, "path");
				const result = await core.getMediaInfo(path, signal);
				return jsonResult(result);
			},
		},
		{
			name: "extract_frame",
			description:
				"Extract one still frame from a video at timeSeconds. " +
				"Optional output path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				timeSeconds: { type: "number" },
				output: { type: "string" },
			}, ["path", "timeSeconds"]),
			execute: async (rawArgs, signal) => {
				const args = requiredPath(rawArgs, "path");
				return jobResult(await core.extractFrame({
					path: args,
					timeSeconds: requiredNumber(rawArgs, "timeSeconds"),
					output: optionalPath(rawArgs, "output"),
				}, signal));
			},
		},
		{
			name: "extract_clip",
			description:
				"Cut a clip from startSeconds for durationSeconds. " +
				"Optional output path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				startSeconds: { type: "number" },
				durationSeconds: { type: "number" },
				output: { type: "string" },
			}, ["path", "startSeconds", "durationSeconds"]),
			execute: async (rawArgs, signal) => {
				return jobResult(await core.extractClip({
					path: requiredPath(rawArgs, "path"),
					startSeconds: requiredNumber(rawArgs, "startSeconds"),
					durationSeconds: requiredNumber(rawArgs, "durationSeconds"),
					output: optionalPath(rawArgs, "output"),
				}, signal));
			},
		},
		{
			name: "resize_video",
			description:
				"Resize a video by width, height, and/or maxEdge. " +
				"Optional output path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				width: { type: "number" },
				height: { type: "number" },
				maxEdge: { type: "number" },
				output: { type: "string" },
			}, ["path"]),
			execute: async (rawArgs, signal) => {
				return jobResult(await core.resizeVideo({
					path: requiredPath(rawArgs, "path"),
					width: optionalNumber(rawArgs, "width"),
					height: optionalNumber(rawArgs, "height"),
					maxEdge: optionalNumber(rawArgs, "maxEdge"),
					output: optionalPath(rawArgs, "output"),
				}, signal));
			},
		},
		{
			name: "crop_video",
			description:
				"Crop a video to x,y,width,height. Optional output path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				x: { type: "number" },
				y: { type: "number" },
				width: { type: "number" },
				height: { type: "number" },
				output: { type: "string" },
			}, ["path", "x", "y", "width", "height"]),
			execute: async (rawArgs, signal) => {
				return jobResult(await core.cropVideo({
					path: requiredPath(rawArgs, "path"),
					x: requiredNumber(rawArgs, "x"),
					y: requiredNumber(rawArgs, "y"),
					width: requiredNumber(rawArgs, "width"),
					height: requiredNumber(rawArgs, "height"),
					output: optionalPath(rawArgs, "output"),
				}, signal));
			},
		},
		{
			name: "convert_format",
			description:
				"Convert a file to another container/format (mp4, webm, gif, mp3, wav, png, jpg, ...). " +
				"Optional output path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				format: { type: "string" },
				output: { type: "string" },
			}, ["path", "format"]),
			execute: async (rawArgs, signal) => {
				const record = asRecord(rawArgs);
				if (typeof record.format !== "string" || !record.format.trim()) {
					throw new TypeError("format must be a non-empty string");
				}
				return jobResult(await core.convertFormat({
					path: requiredPath(rawArgs, "path"),
					format: record.format,
					output: optionalPath(rawArgs, "output"),
				}, signal));
			},
		},
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
				"Run bundled ffmpeg or ffprobe with an argv array when the other media tools are not enough. " +
				"Pass args as a string array. File operands may be workspace-relative or absolute.",
			parameters: {
				type: "object",
				properties: {
					program: { type: "string", enum: ["ffmpeg", "ffprobe"] },
					args: { type: "array", items: { type: "string" } },
				},
				required: ["args"],
				additionalProperties: false,
			},
			execute: async (rawArgs, signal) => {
				const record = asRecord(rawArgs);
				if (record.program !== undefined && record.program !== "ffmpeg" && record.program !== "ffprobe") {
					throw new TypeError("program must be ffmpeg or ffprobe");
				}
				if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string")) {
					throw new TypeError("args must be an array of strings");
				}
				return jobResult(await core.runFfmpeg({
					program: record.program,
					args: record.args,
				}, signal));
			},
		},
	];
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
