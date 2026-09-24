import { isAbsolute } from "node:path";
import type { LibraryPaths } from "../library/paths.ts";

const DENIED_PROTOCOLS =
	/^(https?|tls|tcp|udp|rtp|rtsp|rtsps?|rtmp|rtmps|srt|srtp|ftp|sftp|smb|crypto|concat|subfile|data|tee|gopher|ipfs|file|pipe):/i;

const FILTER_FILE_SOURCES = /\b(movie|amovie|subtitles)\s*=/i;
const INPUT_FLAGS = new Set(["-i", "-attach"]);
const FILTER_FLAGS = new Set(["-vf", "-af", "-filter", "-filter_complex", "-filter:v", "-filter:a"]);

export type MediaPolicyCode = "sandbox_required" | "path_jail" | "invalid_args";

export class MediaPolicyError extends Error {
	readonly code: MediaPolicyCode;

	constructor(message: string, code: MediaPolicyCode) {
		super(message);
		this.name = "MediaPolicyError";
		this.code = code;
	}
}

export interface PreparedMediaArgs {
	args: string[];
	outputRelativePaths: string[];
}

export function assertArgv(args: unknown): string[] {
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		throw new MediaPolicyError("args must be an array of strings, not a shell command", "invalid_args");
	}
	if (args.some((arg) => arg.includes("\0"))) {
		throw new MediaPolicyError("args must not contain NUL", "invalid_args");
	}
	return args;
}

/** Resolve a caller-facing library-relative path to an absolute path inside the library. */
export function resolveLibraryPath(relativePath: string, paths: LibraryPaths): { relativePath: string; absolutePath: string } {
	if (typeof relativePath !== "string" || !relativePath.trim()) {
		throw new MediaPolicyError("path must be a non-empty library-relative path", "invalid_args");
	}
	const trimmed = relativePath.trim();
	if (isAbsolute(trimmed) || DENIED_PROTOCOLS.test(trimmed)) {
		throw deniedOrJail(trimmed);
	}
	try {
		const absolutePath = paths.toAbsolutePath(trimmed.replaceAll("\\", "/"));
		if (paths.isLoomPath(absolutePath)) {
			throw new MediaPolicyError("Paths inside .loom are not allowed", "path_jail");
		}
		return { relativePath: paths.toRelativePath(absolutePath), absolutePath };
	} catch (error) {
		if (error instanceof MediaPolicyError) throw error;
		throw new MediaPolicyError("Path is outside the library", "path_jail");
	}
}

export function prepareFfmpegArgs(rawArgs: unknown, paths: LibraryPaths): PreparedMediaArgs {
	const args = assertArgv(rawArgs);
	const rewritten: string[] = [];
	const outputRelativePaths: string[] = [];
	let expectInput = false;
	let expectFilter = false;

	for (const arg of args) {
		if (expectFilter) {
			if (FILTER_FILE_SOURCES.test(arg) || DENIED_PROTOCOLS.test(arg)) {
				throw new MediaPolicyError(
					"Filter file sources and network protocols require the sandbox",
					"sandbox_required",
				);
			}
			rewritten.push(arg);
			expectFilter = false;
			continue;
		}

		if (expectInput) {
			rewritten.push(resolveOperand(arg, paths).absolutePath);
			expectInput = false;
			continue;
		}

		if (INPUT_FLAGS.has(arg)) {
			expectInput = true;
			rewritten.push(arg);
			continue;
		}
		if (FILTER_FLAGS.has(arg)) {
			expectFilter = true;
			rewritten.push(arg);
			continue;
		}
		if (arg.startsWith("-")) {
			rewritten.push(arg);
			continue;
		}

		if (isDeniedSpecifier(arg)) throw deniedOrJail(arg);
		if (looksLikePath(arg)) {
			const resolved = resolveOperand(arg, paths);
			rewritten.push(resolved.absolutePath);
			outputRelativePaths.push(resolved.relativePath);
			continue;
		}

		rewritten.push(arg);
	}

	if (expectInput || expectFilter) {
		throw new MediaPolicyError("FFmpeg arguments are incomplete", "invalid_args");
	}

	return { args: rewritten, outputRelativePaths: [...new Set(outputRelativePaths)] };
}

function resolveOperand(arg: string, paths: LibraryPaths): { relativePath: string; absolutePath: string } {
	if (arg === "-" || arg === "/dev/stdin" || arg === "/dev/stdout" || arg === "/dev/stderr") {
		throw new MediaPolicyError("Pipe and device I/O require the sandbox", "sandbox_required");
	}
	if (isDeniedSpecifier(arg)) throw deniedOrJail(arg);
	if (!looksLikePath(arg)) {
		return { relativePath: arg, absolutePath: arg };
	}
	return resolveLibraryPath(arg, paths);
}

function deniedOrJail(arg: string): MediaPolicyError {
	if (isDeniedSpecifier(arg)) {
		return new MediaPolicyError(`This input requires the sandbox: ${arg}`, "sandbox_required");
	}
	return new MediaPolicyError("Path is outside the library", "path_jail");
}

function isDeniedSpecifier(arg: string): boolean {
	return DENIED_PROTOCOLS.test(arg);
}

function looksLikePath(arg: string): boolean {
	if (!arg || arg.startsWith("-")) return false;
	if (arg.includes("=")) return false;
	return isAbsolute(arg) || arg.includes("/") || arg.includes("\\") || /\.[a-z0-9]{2,5}$/i.test(arg);
}
