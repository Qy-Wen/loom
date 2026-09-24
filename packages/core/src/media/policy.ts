import { isAbsolute, relative, resolve, sep } from "node:path";

export type MediaPolicyCode = "invalid_args";

export class MediaPolicyError extends Error {
	readonly code: MediaPolicyCode;

	constructor(message: string, code: MediaPolicyCode = "invalid_args") {
		super(message);
		this.name = "MediaPolicyError";
		this.code = code;
	}
}

export interface PreparedMediaArgs {
	args: string[];
	outputPaths: string[];
}

export function assertArgv(args: unknown): string[] {
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		throw new MediaPolicyError("args must be an array of strings, not a shell command");
	}
	if (args.some((arg) => arg.includes("\0"))) {
		throw new MediaPolicyError("args must not contain NUL");
	}
	return args;
}

/** Resolve a file path against `cwd`. Relative or absolute; no containment check. */
export function resolveMediaPath(path: string, cwd: string): { path: string; absolutePath: string } {
	if (typeof path !== "string" || !path.trim()) {
		throw new MediaPolicyError("path must be a non-empty string");
	}
	const trimmed = path.trim().replaceAll("\\", "/");
	const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
	return { path: displayPath(absolutePath, cwd), absolutePath };
}

export function prepareFfmpegArgs(rawArgs: unknown, cwd: string): PreparedMediaArgs {
	const args = assertArgv(rawArgs);
	const rewritten: string[] = [];
	const outputPaths: string[] = [];
	let expectInput = false;
	let expectFilter = false;

	for (const arg of args) {
		if (expectFilter) {
			rewritten.push(arg);
			expectFilter = false;
			continue;
		}

		if (expectInput) {
			rewritten.push(resolveOperand(arg, cwd).absolutePath);
			expectInput = false;
			continue;
		}

		if (arg === "-i" || arg === "-attach") {
			expectInput = true;
			rewritten.push(arg);
			continue;
		}
		if (arg === "-vf" || arg === "-af" || arg === "-filter" || arg === "-filter_complex" || arg === "-filter:v" || arg === "-filter:a") {
			expectFilter = true;
			rewritten.push(arg);
			continue;
		}
		if (arg.startsWith("-")) {
			rewritten.push(arg);
			continue;
		}

		if (looksLikePath(arg) && !isFfmpegSpecifier(arg)) {
			const resolved = resolveMediaPath(arg, cwd);
			rewritten.push(resolved.absolutePath);
			outputPaths.push(resolved.path);
			continue;
		}

		rewritten.push(arg);
	}

	if (expectInput || expectFilter) {
		throw new MediaPolicyError("FFmpeg arguments are incomplete");
	}

	return { args: rewritten, outputPaths: [...new Set(outputPaths)] };
}

function resolveOperand(arg: string, cwd: string): { path: string; absolutePath: string } {
	if (isFfmpegSpecifier(arg) || !looksLikePath(arg)) {
		return { path: arg, absolutePath: arg };
	}
	return resolveMediaPath(arg, cwd);
}

function isFfmpegSpecifier(arg: string): boolean {
	if (arg === "-" || arg.startsWith("/dev/")) return true;
	if (/^[a-zA-Z]:[\\/]/.test(arg)) return false;
	return /^[a-z][a-z0-9+.-]*:/i.test(arg);
}

function looksLikePath(arg: string): boolean {
	if (!arg || arg.startsWith("-")) return false;
	if (arg.includes("=")) return false;
	return isAbsolute(arg) || arg.includes("/") || arg.includes("\\") || /\.[a-z0-9]{2,5}$/i.test(arg);
}

function displayPath(absolutePath: string, cwd: string): string {
	const value = relative(cwd, absolutePath);
	if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
		return absolutePath;
	}
	return value.split(sep).join("/");
}
