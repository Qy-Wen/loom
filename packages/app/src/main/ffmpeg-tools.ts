import type { LocalCore, MediaJobResult } from "@loom/core";
import type { LoomTool, LoomToolResult } from "@loom/agent";

/**
 * Agent-facing FFmpeg tools. Callers use library-relative paths only.
 */
export function createFfmpegTools(core: LocalCore): LoomTool[] {
	return [
		{
			name: "get_media_info",
			description:
				"Read duration, resolution, codecs, and format for one library file. " +
				"Pass a library-relative path such as clips/hero.mp4. Prefer this over run_ffmpeg for inspection.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Library-relative path." },
				},
				required: ["path"],
				additionalProperties: false,
			},
			execute: async (rawArgs) => {
				const path = requiredPath(rawArgs, "path");
				const result = await core.getMediaInfo(path);
				return jsonResult(result);
			},
		},
		{
			name: "extract_frame",
			description:
				"Extract one still frame from a video at timeSeconds. " +
				"Optional output is a library-relative path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				timeSeconds: { type: "number" },
				output: { type: "string" },
			}, ["path", "timeSeconds"]),
			execute: async (rawArgs) => {
				const args = requiredPath(rawArgs, "path");
				return jobResult(await core.extractFrame({
					path: args,
					timeSeconds: requiredNumber(rawArgs, "timeSeconds"),
					output: optionalPath(rawArgs, "output"),
				}));
			},
		},
		{
			name: "extract_clip",
			description:
				"Cut a clip from startSeconds for durationSeconds. " +
				"Optional output is a library-relative path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				startSeconds: { type: "number" },
				durationSeconds: { type: "number" },
				output: { type: "string" },
			}, ["path", "startSeconds", "durationSeconds"]),
			execute: async (rawArgs) => {
				return jobResult(await core.extractClip({
					path: requiredPath(rawArgs, "path"),
					startSeconds: requiredNumber(rawArgs, "startSeconds"),
					durationSeconds: requiredNumber(rawArgs, "durationSeconds"),
					output: optionalPath(rawArgs, "output"),
				}));
			},
		},
		{
			name: "resize_video",
			description:
				"Resize a video by width, height, and/or maxEdge. " +
				"Optional output is a library-relative path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				width: { type: "number" },
				height: { type: "number" },
				maxEdge: { type: "number" },
				output: { type: "string" },
			}, ["path"]),
			execute: async (rawArgs) => {
				return jobResult(await core.resizeVideo({
					path: requiredPath(rawArgs, "path"),
					width: optionalNumber(rawArgs, "width"),
					height: optionalNumber(rawArgs, "height"),
					maxEdge: optionalNumber(rawArgs, "maxEdge"),
					output: optionalPath(rawArgs, "output"),
				}));
			},
		},
		{
			name: "crop_video",
			description:
				"Crop a video to x,y,width,height. Optional output is a library-relative path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				x: { type: "number" },
				y: { type: "number" },
				width: { type: "number" },
				height: { type: "number" },
				output: { type: "string" },
			}, ["path", "x", "y", "width", "height"]),
			execute: async (rawArgs) => {
				return jobResult(await core.cropVideo({
					path: requiredPath(rawArgs, "path"),
					x: requiredNumber(rawArgs, "x"),
					y: requiredNumber(rawArgs, "y"),
					width: requiredNumber(rawArgs, "width"),
					height: requiredNumber(rawArgs, "height"),
					output: optionalPath(rawArgs, "output"),
				}));
			},
		},
		{
			name: "convert_format",
			description:
				"Convert a file to another container/format (mp4, webm, gif, mp3, wav, png, jpg, ...). " +
				"Optional output is a library-relative path; defaults to outputs/.",
			parameters: objectSchema({
				path: { type: "string" },
				format: { type: "string" },
				output: { type: "string" },
			}, ["path", "format"]),
			execute: async (rawArgs) => {
				const record = asRecord(rawArgs);
				if (typeof record.format !== "string" || !record.format.trim()) {
					throw new TypeError("format must be a non-empty string");
				}
				return jobResult(await core.convertFormat({
					path: requiredPath(rawArgs, "path"),
					format: record.format,
					output: optionalPath(rawArgs, "output"),
				}));
			},
		},
		{
			name: "run_ffmpeg",
			description:
				"Run bundled ffmpeg or ffprobe with an argv array when the other media tools are not enough. " +
				"File operands must be library-relative paths. Do not pass a shell string or absolute paths. " +
				"Network inputs and concat/file protocols are rejected until the sandbox exists.",
			parameters: {
				type: "object",
				properties: {
					program: { type: "string", enum: ["ffmpeg", "ffprobe"] },
					args: { type: "array", items: { type: "string" } },
				},
				required: ["args"],
				additionalProperties: false,
			},
			execute: async (rawArgs) => {
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
				}));
			},
		},
	];
}

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
		throw new TypeError(`${name} must be a non-empty library-relative path`);
	}
	return record[name];
}

function optionalPath(value: unknown, name: string): string | undefined {
	const record = asRecord(value);
	if (record[name] === undefined) return undefined;
	if (typeof record[name] !== "string" || !record[name].trim()) {
		throw new TypeError(`${name} must be a non-empty library-relative path`);
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
