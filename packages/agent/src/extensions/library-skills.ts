import type { Context } from "@earendil-works/chord/context";
import ignore from "ignore";
import { parse } from "yaml";
import { LibraryPaths } from "@loom/core/paths";
import type { ExecutionEnv } from "../durable-adapter.ts";

/** Library-relative POSIX path of the skills catalog. */
export const LIBRARY_SKILLS_DIR = LibraryPaths.SKILLS_RELATIVE;
export interface Skill {
	name: string;
	description: string;
	filePath: string;
	content: string;
	disableModelInvocation: boolean;
}
export interface SkillDiagnostic {
	type: "warning";
	path: string;
	message: string;
}
export function isSkillName(name: string): boolean {
	return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
const posix = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Environment-only discovery. Bodies remain on disk; the model reads a selected SKILL.md with read. */
export async function loadLibrarySkills(env: ExecutionEnv, libraryRoot: string, context: Context, userRoot?: string): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const joined = await env.joinPath([libraryRoot, LIBRARY_SKILLS_DIR], context);
	if (!joined.ok) throw joined.error;
	const library = await loadSkillsDirectory(env, joined.value, context);
	const appRoot = userRoot?.trim();
	if (!appRoot) return library;
	const app = await loadSkillsDirectory(env, appRoot, context);
	return mergeSkillCatalogs(app, library);
}

/** App skills first. A library skill with the same name replaces the app skill. */
function mergeSkillCatalogs(
	app: { skills: Skill[]; diagnostics: SkillDiagnostic[] },
	library: { skills: Skill[]; diagnostics: SkillDiagnostic[] },
): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skills = [...app.skills];
	const diagnostics = [...app.diagnostics];
	const index = new Map(skills.map((skill, position) => [skill.name, position]));
	for (const skill of library.skills) {
		const at = index.get(skill.name);
		if (at === undefined) {
			index.set(skill.name, skills.length);
			skills.push(skill);
		} else {
			skills[at] = skill;
			diagnostics.push({ type: "warning", path: skill.filePath, message: `Library skill overrides the app skill: ${skill.name}` });
		}
	}
	diagnostics.push(...library.diagnostics);
	return { skills, diagnostics };
}

async function loadSkillsDirectory(env: ExecutionEnv, root: string, context: Context): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	const warn = (path: string, message: string) => diagnostics.push({ type: "warning", path, message });
	const canonical = await env.canonicalPath(root, context);
	if (!canonical.ok) {
		if (canonical.error.code === "aborted") throw canonical.error;
		if (canonical.error.code !== "not_found") warn(root, canonical.error.message);
		return { skills, diagnostics };
	}
	const rootKey = posix(canonical.value);
	const seen = new Set<string>();
	const names = new Set<string>();
	async function load(path: string, directoryName: string, declared: boolean) {
		const result = await env.readTextFile(path, context);
		if (!result.ok) { if (result.error.code === "aborted") throw result.error; warn(path, result.error.message); return; }
		try {
			const raw = result.value.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
			const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw);
			const metadata: unknown = match ? parse(match[1]!, { maxAliasCount: 100 }) : {};
			if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Skill frontmatter must be a mapping");
			const fields = metadata as Record<string, unknown>;
			const description = typeof fields.description === "string" ? fields.description.trim() : "";
			if (!description) { if (declared) warn(path, "description is required"); return; }
			const name = typeof fields.name === "string" && fields.name ? fields.name : directoryName;
			if (!isSkillName(name)) warn(path, "Invalid skill name (1–64 lowercase letters, numbers, and single hyphens)");
			if (declared && name !== directoryName) warn(path, "Skill name does not match its directory");
			if (description.length > 1024) warn(path, "Skill description exceeds 1024 characters");
			if (names.has(name)) { warn(path, `Duplicate skill name: ${name}`); return; }
			names.add(name);
			skills.push({ name, description, filePath: path, content: raw.slice(match?.[0].length ?? 0).trim(), disableModelInvocation: fields["disable-model-invocation"] === true });
		} catch (error) { if (declared) warn(path, error instanceof Error ? error.message : String(error)); }
	}
	async function visit(dir: string, rootFiles: boolean, rules: string[]) {
		context.abortSignal?.throwIfAborted();
		const target = await env.canonicalPath(dir, context);
		if (!target.ok) { if (target.error.code === "aborted") throw target.error; warn(dir, target.error.message); return; }
		const key = posix(target.value);
		// Canonical identity prevents repeated traversal and leaving the skills root.
		if (seen.has(key) || (key !== rootKey && !key.startsWith(`${rootKey}/`))) return;
		seen.add(key);
		const prefix = posix(dir).slice(posix(root).length).replace(/^\//, "");
		const localRules = [...rules];
		for (const name of [".gitignore", ".ignore", ".fdignore"]) {
			const path = await env.joinPath([dir, name], context); if (!path.ok) throw path.error;
			const file = await env.readTextFile(path.value, context);
			if (!file.ok) { if (file.error.code === "aborted") throw file.error; if (file.error.code !== "not_found") warn(path.value, file.error.message); continue; }
			for (const line of file.value.split(/\r?\n/)) {
				if (!line.trim() || line.startsWith("#")) continue;
				const negated = line.startsWith("!");
				const pattern = (negated ? line.slice(1) : line).replace(/^\//, "");
				localRules.push(`${negated ? "!" : ""}${prefix ? `${prefix}/` : ""}${pattern}`);
			}
		}
		const matcher = ignore().add(localRules);
		const listing = await env.listDir(dir, context);
		if (!listing.ok) { if (listing.error.code === "aborted") throw listing.error; warn(dir, listing.error.message); return; }
		const entries = listing.value.sort((a, b) => a.name.localeCompare(b.name));
		const relative = (path: string) => posix(path).slice(posix(root).length + 1);
		const skill = entries.find((entry) => entry.name === "SKILL.md" && entry.kind === "file" && !matcher.ignores(relative(entry.path)));
		const directoryName = posix(dir).split("/").at(-1)!;
		if (skill) { await load(skill.path, directoryName, true); return; }
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			// Do not follow symlinks: avoid cycles and cataloguing files outside this skills directory.
			if (matcher.ignores(`${relative(entry.path)}${entry.kind === "directory" ? "/" : ""}`)) continue;
			if (entry.kind === "directory") await visit(entry.path, false, localRules);
			else if (entry.kind === "file" && rootFiles && entry.name.endsWith(".md")) await load(entry.path, directoryName, false);
		}
	}
	await visit(root, true, []);
	return { skills, diagnostics };
}

export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
	const offered = skills.filter((skill) => !skill.disableModelInvocation);
	if (!offered.length) return "";
	return "The following skills provide specialized instructions for specific tasks. Read the SKILL.md with read when its description matches the task. Resolve references relative to that skill's directory.\n\n<available_skills>\n" + offered.map((skill) => `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n    <location>${escapeXml(skill.filePath)}</location>\n  </skill>`).join("\n") + "\n</available_skills>";
}
