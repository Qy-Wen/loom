import type { Context } from "@earendil-works/chord/context";
import ignore from "ignore";
import { Document, isMap, parse, parseDocument } from "yaml";
import { LibraryPaths } from "@loom/core/paths";
import type { ExecutionEnv } from "../durable-adapter.ts";

/** Library-relative POSIX path of the skills catalog. */
export const LIBRARY_SKILLS_DIR = LibraryPaths.SKILLS_RELATIVE;
/** Hidden state file inside a skills root storing disabled skill names. */
export const SKILLS_STATE_FILE = ".loom-skills.json";
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export type SkillScope = "user" | "library";
export type SkillKind = "directory" | "file";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	content: string;
	disableModelInvocation: boolean;
}
export interface InspectedSkill extends Skill {
	scope: SkillScope;
	kind: SkillKind;
	/** Skill directory for `<name>/SKILL.md`, or the skills root for standalone `.md` files. */
	baseDir: string;
	enabled: boolean;
	overriddenByLibrary: boolean;
	overridesUser: boolean;
}
export interface SkillDiagnostic {
	type: "warning";
	path: string;
	message: string;
}
export interface ScopedSkillDiagnostic extends SkillDiagnostic {
	scope: SkillScope;
}
export interface InspectedSkillsCatalog {
	user: InspectedSkill[];
	library: InspectedSkill[];
	diagnostics: ScopedSkillDiagnostic[];
}
export interface SkillsState {
	disabled: string[];
}
export interface ParsedSkillMarkdown {
	name: string;
	description: string;
	content: string;
	disableModelInvocation: boolean;
	hasFrontmatter: boolean;
}
export function isSkillName(name: string): boolean {
	return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
export function parseSkillsState(raw: unknown): SkillsState {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Skills state must be a JSON object");
	const { disabled } = raw as Record<string, unknown>;
	if (disabled === undefined) return { disabled: [] };
	if (!Array.isArray(disabled) || !disabled.every((item) => typeof item === "string")) {
		throw new Error("Skills state disabled list must be an array of strings");
	}
	return { disabled: [...new Set(disabled.map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)) };
}
const posix = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export function parseSkillMarkdown(raw: string, fallbackName: string): ParsedSkillMarkdown {
	const normalized = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
	const match = FRONTMATTER_RE.exec(normalized);
	const metadata: unknown = match ? parse(match[1]!, { maxAliasCount: 100 }) : {};
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Skill frontmatter must be a mapping");
	const fields = metadata as Record<string, unknown>;
	const description = typeof fields.description === "string" ? fields.description.trim() : "";
	const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : fallbackName;
	return {
		name,
		description,
		content: normalized.slice(match?.[0].length ?? 0).trim(),
		disableModelInvocation: fields["disable-model-invocation"] === true,
		hasFrontmatter: Boolean(match),
	};
}

/** Update or build a SKILL.md document while preserving unknown YAML frontmatter fields. */
export function formatSkillDocument(
	existingRaw: string | undefined,
	fields: { name?: string; description: string; disableModelInvocation?: boolean; content: string },
): string {
	const description = fields.description.trim();
	if (!description) throw new Error("Skill description is required");
	if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
		throw new Error(`Skill description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters`);
	}
	let doc: Document;
	if (existingRaw !== undefined) {
		const normalized = existingRaw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
		const match = FRONTMATTER_RE.exec(normalized);
		if (match) {
			doc = parseDocument(match[1]!);
			if (doc.errors.length > 0) throw new Error(doc.errors[0]!.message);
			if (!isMap(doc.contents)) throw new Error("Skill frontmatter must be a mapping");
		} else {
			doc = new Document({});
		}
	} else {
		doc = new Document({});
	}
	if (fields.name !== undefined) doc.set("name", fields.name);
	doc.set("description", description);
	if (fields.disableModelInvocation === true) doc.set("disable-model-invocation", true);
	else if (fields.disableModelInvocation === false) doc.delete("disable-model-invocation");
	const frontmatter = doc.toString({ lineWidth: 0 }).trimEnd();
	const body = fields.content.replaceAll("\r\n", "\n").trim();
	return body ? `---\n${frontmatter}\n---\n\n${body}\n` : `---\n${frontmatter}\n---\n`;
}

type DiscoveredSkill = Skill & { kind: SkillKind; baseDir: string; enabled: boolean };

/** Environment-only discovery. Bodies remain on disk; the model reads a selected SKILL.md with read. */
export async function loadLibrarySkills(env: ExecutionEnv, libraryRoot: string, context: Context, userRoot?: string): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const joined = await env.joinPath([libraryRoot, LIBRARY_SKILLS_DIR], context);
	if (!joined.ok) throw joined.error;
	const library = await loadSkillsDirectory(env, joined.value, context);
	const enabledLibrary = { skills: library.skills.filter((skill) => skill.enabled).map(toPublicSkill), diagnostics: library.diagnostics };
	const appRoot = userRoot?.trim();
	if (!appRoot) return enabledLibrary;
	const app = await loadSkillsDirectory(env, appRoot, context);
	const enabledApp = { skills: app.skills.filter((skill) => skill.enabled).map(toPublicSkill), diagnostics: app.diagnostics };
	return mergeSkillCatalogs(enabledApp, enabledLibrary);
}

/** Full catalog inspection for settings UI, preserving disabled and overridden entries. */
export async function inspectLibrarySkills(
	env: ExecutionEnv,
	options: { libraryRoot?: string; userRoot?: string },
	context: Context,
): Promise<InspectedSkillsCatalog> {
	const userRoot = options.userRoot?.trim();
	const libraryRoot = options.libraryRoot?.trim();
	const userResult = userRoot ? await loadSkillsDirectory(env, userRoot, context) : { skills: [], diagnostics: [] };
	let libraryResult: { skills: DiscoveredSkill[]; diagnostics: SkillDiagnostic[] } = { skills: [], diagnostics: [] };
	if (libraryRoot) {
		const joined = await env.joinPath([libraryRoot, LIBRARY_SKILLS_DIR], context);
		if (!joined.ok) throw joined.error;
		libraryResult = await loadSkillsDirectory(env, joined.value, context);
	}
	const enabledLibraryNames = new Set(libraryResult.skills.filter((skill) => skill.enabled).map((skill) => skill.name));
	const enabledUserNames = new Set(userResult.skills.filter((skill) => skill.enabled).map((skill) => skill.name));
	return {
		user: userResult.skills.map((skill) => ({
			...skill,
			scope: "user",
			overriddenByLibrary: skill.enabled && enabledLibraryNames.has(skill.name),
			overridesUser: false,
		})),
		library: libraryResult.skills.map((skill) => ({
			...skill,
			scope: "library",
			overriddenByLibrary: false,
			overridesUser: skill.enabled && enabledUserNames.has(skill.name),
		})),
		diagnostics: [
			...userResult.diagnostics.map((item) => ({ ...item, scope: "user" as const })),
			...libraryResult.diagnostics.map((item) => ({ ...item, scope: "library" as const })),
		],
	};
}

function toPublicSkill({ name, description, filePath, content, disableModelInvocation }: DiscoveredSkill): Skill {
	return { name, description, filePath, content, disableModelInvocation };
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

async function readDisabledSkills(
	env: ExecutionEnv,
	root: string,
	context: Context,
	warn: (path: string, message: string) => void,
): Promise<Set<string>> {
	const statePath = await env.joinPath([root, SKILLS_STATE_FILE], context);
	if (!statePath.ok) throw statePath.error;
	const text = await env.readTextFile(statePath.value, context);
	if (!text.ok) {
		if (text.error.code === "aborted") throw text.error;
		if (text.error.code !== "not_found") warn(statePath.value, text.error.message);
		return new Set();
	}
	try {
		return new Set(parseSkillsState(JSON.parse(text.value)).disabled);
	} catch (error) {
		warn(statePath.value, error instanceof Error ? error.message : String(error));
		return new Set();
	}
}

async function loadSkillsDirectory(env: ExecutionEnv, root: string, context: Context): Promise<{ skills: DiscoveredSkill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: DiscoveredSkill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	const warn = (path: string, message: string) => diagnostics.push({ type: "warning", path, message });
	const canonical = await env.canonicalPath(root, context);
	if (!canonical.ok) {
		if (canonical.error.code === "aborted") throw canonical.error;
		if (canonical.error.code !== "not_found") warn(root, canonical.error.message);
		return { skills, diagnostics };
	}
	const disabled = await readDisabledSkills(env, root, context, warn);
	const rootKey = posix(canonical.value);
	const seen = new Set<string>();
	const names = new Set<string>();
	async function load(path: string, baseDir: string, directoryName: string, declared: boolean) {
		const result = await env.readTextFile(path, context);
		if (!result.ok) { if (result.error.code === "aborted") throw result.error; warn(path, result.error.message); return; }
		try {
			const parsed = parseSkillMarkdown(result.value, directoryName);
			if (!parsed.description) { if (declared) warn(path, "description is required"); return; }
			if (!isSkillName(parsed.name)) warn(path, "Invalid skill name (1–64 lowercase letters, numbers, and single hyphens)");
			if (declared && parsed.name !== directoryName) warn(path, "Skill name does not match its directory");
			if (parsed.description.length > SKILL_DESCRIPTION_MAX_LENGTH) warn(path, `Skill description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters`);
			if (names.has(parsed.name)) { warn(path, `Duplicate skill name: ${parsed.name}`); return; }
			names.add(parsed.name);
			skills.push({
				name: parsed.name,
				description: parsed.description,
				filePath: path,
				baseDir,
				kind: declared ? "directory" : "file",
				content: parsed.content,
				disableModelInvocation: parsed.disableModelInvocation,
				enabled: !disabled.has(parsed.name),
			});
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
		if (skill) { await load(skill.path, dir, directoryName, true); return; }
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			// Do not follow symlinks: avoid cycles and cataloguing files outside this skills directory.
			if (matcher.ignores(`${relative(entry.path)}${entry.kind === "directory" ? "/" : ""}`)) continue;
			if (entry.kind === "directory") await visit(entry.path, false, localRules);
			else if (entry.kind === "file" && rootFiles && entry.name.endsWith(".md")) await load(entry.path, root, directoryName, false);
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
