export const AGENT_PERMISSION_LEVELS = ["basic", "standard", "full"] as const;

export type AgentPermissionLevel = (typeof AGENT_PERMISSION_LEVELS)[number];

/** Product default: confirm writes outside the open library. Evals that must not hang should set `full`. */
export const DEFAULT_AGENT_PERMISSION: AgentPermissionLevel = "standard";

export const AGENT_PERMISSION_OPTIONS = [
	{ value: "basic", label: "Basic permission" },
	{ value: "standard", label: "Standard permission" },
	{ value: "full", label: "Full permission" },
] as const satisfies ReadonlyArray<{ value: AgentPermissionLevel; label: string }>;

export type ToolGateDecision = "approve" | "reject";

const STANDARD_TOOLS = ["write", "edit"] as const;
/** Child processes that can write. `get_media_info` only reads, so it is not here. */
const PROCESS_TOOLS = ["bash", "extract_frame", "extract_clip", "resize_video", "crop_video", "convert_format", "run_ffmpeg"] as const;
const BASIC_TOOLS = ["write", "edit", ...PROCESS_TOOLS] as const;

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
): boolean {
	if (!toolNeedsApproval(level, toolName)) return false;
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

export class ToolApprovalQueue {
	private readonly pending = new Map<string, {
		sessionId: string;
		resolve: (decision: ToolGateDecision | "abort") => void;
	}>();

	wait(sessionId: string, toolCallId: string, signal?: AbortSignal): Promise<ToolGateDecision | "abort"> {
		if (signal?.aborted) return Promise.resolve("abort");
		return new Promise((resolve) => {
			const finish = (decision: ToolGateDecision | "abort") => {
				if (!this.pending.delete(toolCallId)) return;
				signal?.removeEventListener("abort", onAbort);
				resolve(decision);
			};
			const onAbort = () => finish("abort");
			this.pending.set(toolCallId, { sessionId, resolve: finish });
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	resolve(toolCallId: string, decision: ToolGateDecision): boolean {
		const row = this.pending.get(toolCallId);
		if (!row) return false;
		row.resolve(decision);
		return true;
	}

	abortSession(sessionId: string): void {
		for (const [toolCallId, row] of [...this.pending]) {
			if (row.sessionId === sessionId) row.resolve("abort");
		}
	}

	abortAll(): void {
		for (const row of [...this.pending.values()]) row.resolve("abort");
	}

	approveAll(): void {
		for (const row of [...this.pending.values()]) row.resolve("approve");
	}

	get size(): number {
		return this.pending.size;
	}
}
