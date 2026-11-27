import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	BACKGROUND_CONTEXT,
	LIBRARY_SKILLS_DIR,
	NodeExecutionEnv,
	SKILLS_STATE_FILE,
	formatSkillDocument,
	inspectLibrarySkills,
	parseSkillsState,
	type InspectedSkill,
} from "@loom/agent/durable";
import {
	SKILL_DESCRIPTION_MAX_LENGTH,
	isReservedSkillName,
	isValidSkillName,
	type CreateSkillInput,
	type SkillDetail,
	type SkillScope,
	type SkillSummary,
	type SkillsSettingsView,
	type UpdateSkillInput,
} from "../../shared/skills-settings.ts";
import { JsonFile, atomicWrite } from "../storage/file.ts";

const SUPPORTING_FILE_LIMIT = 200;
const SKIPPED_DIR_NAMES = new Set([".git", "node_modules"]);

export interface SkillsServiceOptions {
	userSkillsDir: string;
	getLibraryRoot: () => string | null;
	trashItem: (path: string) => Promise<void>;
	openPath: (path: string) => Promise<string>;
	showItemInFolder: (path: string) => void;
}

function toPosix(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function toRelativePosix(root: string, target: string): string {
	const rel = relative(root, target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Path is outside the skills directory.");
	}
	return rel.split(sep).join("/");
}

function validateSkillName(name: string): string {
	const trimmed = name.trim();
	if (!isValidSkillName(trimmed)) {
		throw new Error("Skill name must be 1–64 lowercase letters, numbers, and single hyphens.");
	}
	if (isReservedSkillName(trimmed)) {
		throw new Error(`"${trimmed}" is reserved for a built-in chat command.`);
	}
	return trimmed;
}

function validateDescription(description: string): string {
	const trimmed = description.trim();
	if (!trimmed) throw new Error("Skill description is required.");
	if (trimmed.length > SKILL_DESCRIPTION_MAX_LENGTH) {
		throw new Error(`Skill description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`);
	}
	return trimmed;
}

async function listSupportingFiles(baseDir: string, kind: "directory" | "file"): Promise<string[]> {
	if (kind !== "directory") return [];
	const rootCanonical = await realpath(baseDir).catch(() => null);
	if (!rootCanonical) return [];
	const files: string[] = [];
	async function walk(dir: string) {
		if (files.length >= SUPPORTING_FILE_LIMIT) return;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (files.length >= SUPPORTING_FILE_LIMIT) return;
			if (entry.name === ".DS_Store" || SKIPPED_DIR_NAMES.has(entry.name)) continue;
			if (entry.isSymbolicLink()) continue;
			const full = join(dir, entry.name);
			if (dir === baseDir && entry.isFile() && entry.name === "SKILL.md") continue;
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				files.push(toRelativePosix(baseDir, full));
			}
		}
	}
	await walk(baseDir);
	return files;
}

async function findExistingEntryIgnoreCase(root: string, name: string): Promise<string | null> {
	const entries = await readdir(root).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	const needle = name.toLowerCase();
	const matched = entries.find((entry) => entry.toLowerCase() === needle);
	return matched ? join(root, matched) : null;
}

export class SkillsService {
	readonly #options: SkillsServiceOptions;

	constructor(options: SkillsServiceOptions) {
		this.#options = options;
	}

	userDir(): string {
		return resolve(this.#options.userSkillsDir);
	}

	libraryDir(): string | null {
		const root = this.#options.getLibraryRoot();
		if (!root) return null;
		return resolve(root, ...LIBRARY_SKILLS_DIR.split("/"));
	}

	#scopeDir(scope: SkillScope): string {
		if (scope === "user") return this.userDir();
		const dir = this.libraryDir();
		if (!dir) throw new Error("Open a library first.");
		return dir;
	}

	#stateFile(scope: SkillScope): JsonFile<{ disabled: string[] }> {
		return new JsonFile(join(this.#scopeDir(scope), SKILLS_STATE_FILE), parseSkillsState, { recoverCorrupt: true });
	}

	async #canonicalChild(root: string, target: string, allowRoot = false): Promise<string> {
		const canonicalRoot = await realpath(root);
		const canonicalTarget = await realpath(target);
		if (allowRoot && canonicalTarget === canonicalRoot) return canonicalTarget;
		const rel = relative(canonicalRoot, canonicalTarget);
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			throw new Error("Path is outside the skills directory.");
		}
		return canonicalTarget;
	}

	async #inspect() {
		const libraryRoot = this.#options.getLibraryRoot() ?? undefined;
		const userRoot = this.userDir();
		const cwd = libraryRoot ?? userRoot;
		return inspectLibrarySkills(new NodeExecutionEnv({ cwd }), { libraryRoot, userRoot }, BACKGROUND_CONTEXT);
	}

	async #toSummary(skill: InspectedSkill, scopeRoot: string): Promise<SkillSummary> {
		const supportingFiles = await listSupportingFiles(skill.baseDir, skill.kind);
		return {
			id: toRelativePosix(scopeRoot, skill.filePath),
			scope: skill.scope,
			kind: skill.kind,
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			enabled: skill.enabled,
			disableModelInvocation: skill.disableModelInvocation,
			overriddenByLibrary: skill.overriddenByLibrary,
			overridesUser: skill.overridesUser,
			supportingFileCount: supportingFiles.length,
		};
	}

	async #findSkill(scope: SkillScope, id: string): Promise<{ skill: InspectedSkill; scopeRoot: string }> {
		const scopeRoot = this.#scopeDir(scope);
		const catalog = await this.#inspect();
		const list = scope === "user" ? catalog.user : catalog.library;
		const normalizedId = toPosix(id);
		const match = list.find((item) => toRelativePosix(scopeRoot, item.filePath) === normalizedId);
		if (!match) throw new Error("Skill not found.");
		return { skill: match, scopeRoot };
	}

	async list(): Promise<SkillsSettingsView> {
		const userDir = this.userDir();
		const libraryDir = this.libraryDir();
		const catalog = await this.#inspect();
		const [user, library] = await Promise.all([
			Promise.all(catalog.user.map((skill) => this.#toSummary(skill, userDir))),
			libraryDir ? Promise.all(catalog.library.map((skill) => this.#toSummary(skill, libraryDir))) : Promise.resolve([]),
		]);
		user.sort((a, b) => a.name.localeCompare(b.name));
		library.sort((a, b) => a.name.localeCompare(b.name));
		return {
			userDir,
			libraryDir,
			user,
			library,
			diagnostics: catalog.diagnostics.map(({ scope, path, message }) => ({ scope, path, message })),
		};
	}

	async read(scope: SkillScope, id: string): Promise<SkillDetail> {
		const { skill, scopeRoot } = await this.#findSkill(scope, id);
		const supportingFiles = await listSupportingFiles(skill.baseDir, skill.kind);
		return {
			id: toRelativePosix(scopeRoot, skill.filePath),
			scope: skill.scope,
			kind: skill.kind,
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			enabled: skill.enabled,
			disableModelInvocation: skill.disableModelInvocation,
			overriddenByLibrary: skill.overriddenByLibrary,
			overridesUser: skill.overridesUser,
			supportingFileCount: supportingFiles.length,
			content: skill.content,
			supportingFiles,
		};
	}

	async create(input: CreateSkillInput): Promise<SkillDetail> {
		const scopeRoot = this.#scopeDir(input.scope);
		const name = validateSkillName(input.name);
		const description = validateDescription(input.description);
		const existing = await findExistingEntryIgnoreCase(scopeRoot, name);
		if (existing) throw new Error(`A skill named "${name}" already exists in this location.`);
		const catalog = await this.#inspect();
		const existingByName = (input.scope === "user" ? catalog.user : catalog.library).find((item) => item.name === name);
		if (existingByName) throw new Error(`A skill named "${name}" already exists in this location.`);

		const skillFile = join(scopeRoot, name, "SKILL.md");
		const markdown = formatSkillDocument(undefined, {
			name,
			description,
			disableModelInvocation: false,
			content: input.content ?? "",
		});
		await atomicWrite(skillFile, markdown);
		return this.read(input.scope, `${name}/SKILL.md`);
	}

	async save(input: UpdateSkillInput): Promise<SkillDetail> {
		const { skill, scopeRoot } = await this.#findSkill(input.scope, input.id);
		const description = validateDescription(input.description);
		const canonicalFile = await this.#canonicalChild(scopeRoot, skill.filePath);
		const existingRaw = await readFile(canonicalFile, "utf8");
		const updated = formatSkillDocument(existingRaw, {
			description,
			content: input.content ?? "",
		});
		await atomicWrite(canonicalFile, updated);
		return this.read(input.scope, input.id);
	}

	async setEnabled(scope: SkillScope, name: string, enabled: boolean): Promise<SkillsSettingsView> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Skill name is required.");
		const file = this.#stateFile(scope);
		await file.update(async (current) => {
			if (current === undefined && enabled) return { result: undefined };
			const set = new Set(current?.disabled ?? []);
			if (enabled) set.delete(trimmed);
			else set.add(trimmed);
			return { value: { disabled: [...set].sort((a, b) => a.localeCompare(b)) }, result: undefined };
		});
		return this.list();
	}

	async delete(scope: SkillScope, id: string): Promise<SkillsSettingsView> {
		const { skill, scopeRoot } = await this.#findSkill(scope, id);
		const target = skill.kind === "directory" ? skill.baseDir : skill.filePath;
		const canonicalTarget = await this.#canonicalChild(scopeRoot, target, false);
		await this.#options.trashItem(canonicalTarget);
		await this.#clearDisabledName(scope, skill.name);
		return this.list();
	}

	async #clearDisabledName(scope: SkillScope, name: string): Promise<void> {
		const file = this.#stateFile(scope);
		await file.update(async (current) => {
			if (!current || !current.disabled.includes(name)) return { result: undefined };
			return {
				value: { disabled: current.disabled.filter((item) => item !== name) },
				result: undefined,
			};
		});
	}

	async openFolder(scope: SkillScope, targetPath?: string): Promise<void> {
		const scopeRoot = this.#scopeDir(scope);
		if (!targetPath) {
			await mkdir(scopeRoot, { recursive: true });
			const error = await this.#options.openPath(scopeRoot);
			if (error) throw new Error(error);
			return;
		}
		const canonicalTarget = await this.#canonicalChild(scopeRoot, targetPath, true);
		this.#options.showItemInFolder(canonicalTarget);
	}
}
