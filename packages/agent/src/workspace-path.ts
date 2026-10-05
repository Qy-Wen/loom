import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
	pathInsideWorkspace,
	toolNeedsApproval,
	toolPathArg,
	type AgentPermissionLevel,
} from "./tool-permission.ts";

/** Absolute path of a write target. Follows an existing symlink; missing parents stay lexical. */
export function canonicalWorkspacePath(root: string, raw: string): string | undefined {
	let base: string;
	try {
		base = realpathSync(root);
	} catch {
		return undefined;
	}
	let current = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
	const missing: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(current);
			return missing.length === 0 ? real : resolve(real, ...missing);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") return undefined;
			const parent = dirname(current);
			if (parent === current) return undefined;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Whether this call waits for Approve / Skip.
 * Standard `write` and `edit` inside the open library do not.
 */
export function workspaceWriteNeedsApproval(
	level: AgentPermissionLevel,
	toolName: string,
	root: string | undefined,
	args: unknown,
): boolean {
	if (!toolNeedsApproval(level, toolName)) return false;
	if (level !== "standard" || (toolName !== "write" && toolName !== "edit")) return true;
	if (!root) return true;
	const raw = toolPathArg(args);
	if (raw === undefined) return true;
	const target = canonicalWorkspacePath(root, raw);
	if (!target) return true;
	let base: string;
	try {
		base = realpathSync(root);
	} catch {
		return true;
	}
	return !pathInsideWorkspace(base, target);
}
