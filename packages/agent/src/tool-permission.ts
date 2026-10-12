export const AGENT_PERMISSION_LEVELS = ["basic", "standard", "full"] as const;

export type AgentPermissionLevel = (typeof AGENT_PERMISSION_LEVELS)[number];

/** Product default: confirm writes outside the open library. Evals that must not hang should set `full`. */
export const DEFAULT_AGENT_PERMISSION: AgentPermissionLevel = "standard";

export const AGENT_PERMISSION_OPTIONS = [
	{ value: "basic", label: "Basic permission" },
	{ value: "standard", label: "Standard permission" },
	{ value: "full", label: "Full permission" },
] as const satisfies ReadonlyArray<{ value: AgentPermissionLevel; label: string }>;

export type ToolGateDecision = "approve" | "reject" | "approve_always";

/** One remembered command. No `match` means every call of that tool. */
export type CommandAllow = {
	tool: string;
	match?: string;
};

export type CommandAllowView = {
	allows: CommandAllow[];
	libraryOpen: boolean;
	/** Open library this list belongs to. The renderer ignores a list for another library. */
	root: string | null;
};

/** App settings. Basic and Standard both wait. `get_settings` is not here. */
const SETTINGS_TOOLS = ["update_settings"] as const;
const STANDARD_TOOLS = ["write", "edit", ...SETTINGS_TOOLS] as const;
/** Child processes that can write. `get_media_info` only reads, so it is not here. */
const PROCESS_TOOLS = ["bash", "extract_frame", "extract_clip", "resize_video", "crop_video", "convert_format", "grade_image", "run_ffmpeg"] as const;
const BASIC_TOOLS = ["write", "edit", ...SETTINGS_TOOLS, ...PROCESS_TOOLS] as const;

export function parseAgentPermissionLevel(value: unknown): AgentPermissionLevel {
	if (value === "basic" || value === "standard" || value === "full") return value;
	return DEFAULT_AGENT_PERMISSION;
}

export function gatedToolNames(level: AgentPermissionLevel): ReadonlySet<string> {
	if (level === "full") return new Set();
	if (level === "standard") return new Set(STANDARD_TOOLS);
	return new Set(BASIC_TOOLS);
}

export function toolNeedsApproval(level: AgentPermissionLevel, toolName: string): boolean {
	return gatedToolNames(level).has(toolName);
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Path argument for `write` / `edit`, with the same leading normalization as the tool. */
export function toolPathArg(args: unknown): string | undefined {
	const record = argsRecord(args);
	if (!record || typeof record.path !== "string") return undefined;
	const normalized = record.path.replace(UNICODE_SPACES, " ");
	const stripped = normalized.startsWith("@") ? normalized.slice(1) : normalized;
	return stripped.length > 0 ? stripped : undefined;
}

/**
 * Standard allows `write` and `edit` whose path stays inside the open library.
 * This check is lexical. The process gate follows symlinks before calling it.
 */
export function toolCallNeedsApproval(
	level: AgentPermissionLevel,
	toolName: string,
	root: string | null | undefined,
	args: unknown,
	allows?: readonly CommandAllow[],
): boolean {
	if (!toolNeedsApproval(level, toolName)) return false;
	if (matchesCommandAllow(toolName, args, root, allows)) return false;
	if (level !== "standard" || (toolName !== "write" && toolName !== "edit")) return true;
	if (!root) return true;
	const target = toolPathArg(args);
	if (target === undefined) return true;
	return !pathInsideWorkspace(root, target);
}

/** True when `target` is `root` or a file inside it. Relative paths start at `root`. */
export function pathInsideWorkspace(root: string, target: string): boolean {
	const base = lexicalPath(root, root);
	const resolved = lexicalPath(root, target);
	if (!base || !resolved) return false;
	const left = foldPath(base);
	const right = foldPath(resolved);
	return right === left || right.startsWith(`${left}/`);
}

function argsRecord(args: unknown): { path?: unknown } | undefined {
	if (typeof args === "string") {
		try {
			return argsRecord(JSON.parse(args));
		} catch {
			return undefined;
		}
	}
	if (!args || typeof args !== "object") return undefined;
	return args as { path?: unknown };
}

function lexicalPath(root: string, target: string): string | undefined {
	const base = normalizeSlashes(root);
	const raw = normalizeSlashes(target);
	if (!isAbsolutePath(base) || raw.length === 0) return undefined;
	const joined = isAbsolutePath(raw) ? raw : `${stripTrailing(base)}/${raw}`;
	const unc = joined.startsWith("//");
	const drive = /^[A-Za-z]:\//.exec(joined)?.[0] ?? "";
	const body = drive ? joined.slice(drive.length) : unc ? joined.slice(2) : joined;
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	const suffix = parts.join("/");
	if (unc) return stripTrailing(`//${suffix}`);
	if (drive) return stripTrailing(suffix ? `${drive}${suffix}` : drive);
	return stripTrailing(`/${suffix}`);
}

function normalizeSlashes(path: string): string {
	return path.replaceAll("\\", "/");
}

function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:\//.test(path);
}

function stripTrailing(path: string): string {
	if (path === "/" || /^[A-Za-z]:\/$/.test(path)) return path;
	return path.replace(/\/+$/, "");
}

function foldPath(path: string): string {
	const windows = (typeof process !== "undefined" && process.platform === "win32") || /^[A-Za-z]:/.test(path);
	return windows ? path.toLowerCase() : path;
}

export function commandAllowId(allow: CommandAllow): string {
	return allow.match === undefined ? allow.tool : `${allow.tool}\0${allow.match}`;
}

export function commandAllowLabel(allow: CommandAllow): string {
	if (allow.tool === "run_ffmpeg" && allow.match) {
		try {
			const parsed: unknown = JSON.parse(allow.match);
			if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed.join(" ");
		} catch {
			return allow.match;
		}
	}
	if (allow.match) return allow.tool === "bash" ? allow.match : `${allow.tool} ${allow.match}`;
	return allow.tool;
}

/** Stable identity for "always allow". Undefined when the call has no specific command to remember. */
export function commandAllowKey(toolName: string, args: unknown, root?: string | null): CommandAllow | undefined {
	if (toolName === "bash") {
		const command = stringField(args, "command")?.trim();
		return command ? { tool: "bash", match: command } : undefined;
	}
	if (toolName === "run_ffmpeg") {
		const match = ffmpegAllowMatch(args);
		return match ? { tool: "run_ffmpeg", match } : undefined;
	}
	if (toolName === "write" || toolName === "edit") {
		const path = toolPathArg(args);
		if (!path) return undefined;
		return { tool: toolName, match: commandAllowPath(root, path) };
	}
	if (!toolName.trim()) return undefined;
	return { tool: toolName };
}

export function matchesCommandAllow(
	toolName: string,
	args: unknown,
	root: string | null | undefined,
	allows: readonly CommandAllow[] | undefined,
): boolean {
	if (!allows || allows.length === 0) return false;
	const key = commandAllowKey(toolName, args, root);
	if (!key) return false;
	const id = commandAllowId(key);
	return allows.some((allow) => commandAllowId(allow) === id);
}

export function parseCommandAllow(value: unknown): CommandAllow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const tool = (value as { tool?: unknown }).tool;
	const match = (value as { match?: unknown }).match;
	if (typeof tool !== "string" || tool.trim().length === 0) return undefined;
	if (match === undefined) return { tool: tool.trim() };
	if (typeof match !== "string" || match.length === 0) return undefined;
	return { tool: tool.trim(), match };
}

export function parseCommandAllows(value: unknown): CommandAllow[] {
	const raw = value && typeof value === "object" && Array.isArray((value as { allows?: unknown }).allows)
		? (value as { allows: unknown[] }).allows
		: [];
	const allows: CommandAllow[] = [];
	const seen = new Set<string>();
	for (const row of raw) {
		const allow = parseCommandAllow(row);
		if (!allow) continue;
		const id = commandAllowId(allow);
		if (seen.has(id)) continue;
		seen.add(id);
		allows.push(allow);
	}
	return allows;
}

function commandAllowPath(root: string | null | undefined, target: string): string {
	if (!root) return foldPath(normalizeSlashes(target));
	const base = lexicalPath(root, root);
	const resolved = lexicalPath(root, target);
	if (!base || !resolved) return foldPath(normalizeSlashes(target));
	const left = foldPath(base);
	const right = foldPath(resolved);
	if (right === left) return ".";
	if (right.startsWith(`${left}/`)) return right.slice(left.length + 1);
	return right;
}

function ffmpegAllowMatch(args: unknown): string | undefined {
	const record = recordOf(args);
	if (!record || !Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string")) return undefined;
	const program = record.program === "ffprobe" ? "ffprobe" : "ffmpeg";
	return JSON.stringify([program, ...(record.args as string[])]);
}

function stringField(args: unknown, key: string): string | undefined {
	const value = recordOf(args)?.[key];
	return typeof value === "string" ? value : undefined;
}

function recordOf(args: unknown): Record<string, unknown> | undefined {
	if (typeof args === "string") {
		try {
			return recordOf(JSON.parse(args));
		} catch {
			return undefined;
		}
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	return args as Record<string, unknown>;
}
