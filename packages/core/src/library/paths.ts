import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Owns all path conversion and containment checks for one portable library.
 * Core code stores POSIX-style relative paths and resolves absolute paths only
 * at the filesystem boundary.
 */
export class LibraryPaths {
	/** Library-relative POSIX path of the skills catalog, for model-facing paths and `ExecutionEnv` joins. */
	static readonly SKILLS_RELATIVE = ".loom/agents/skills";

	readonly root: string;
	/** Everything Loom owns. Never indexed as assets. */
	readonly loom: string;
	readonly metadataDb: string;
	readonly graphDb: string;
	readonly gradeLuts: string;
	/** Disposable preview cache, one `<assetId>.webp` per image or video. The only part of `.loom` that is not user data. */
	readonly thumbnails: string;
	readonly agents: string;
	readonly sessionsDb: string;
	readonly commandAllows: string;
	readonly skills: string;
	readonly memoryDir: string;
	readonly memoryFile: string;
	readonly traces: string;
	readonly toolResults: string;

	constructor(rootPath: string) {
		this.root = resolve(rootPath);
		this.loom = resolve(this.root, ".loom");
		this.metadataDb = resolve(this.loom, "metadata-db", "metadata.db");
		this.graphDb = resolve(this.loom, "graph-db", "graph.db");
		this.gradeLuts = resolve(this.loom, "grades", "luts");
		this.thumbnails = resolve(this.loom, "thumbnails");
		this.agents = resolve(this.loom, "agents");
		this.sessionsDb = resolve(this.agents, "sessions", "loom.sqlite");
		this.commandAllows = resolve(this.agents, "command-allows", "command-allows.json");
		this.skills = resolve(this.root, ...LibraryPaths.SKILLS_RELATIVE.split("/"));
		this.memoryDir = resolve(this.agents, "memory");
		this.memoryFile = resolve(this.memoryDir, "MEMORY.md");
		this.traces = resolve(this.agents, "traces");
		this.toolResults = resolve(this.agents, "tool-results");
	}

	toRelativePath(absolutePath: string): string {
		const value = relative(this.root, resolve(absolutePath));
		if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
			throw new Error(`Path is outside the library: ${absolutePath}`);
		}
		return value.split(sep).join("/");
	}

	toAbsolutePath(relativePath: string): string {
		if (isAbsolute(relativePath)) throw new Error("Expected a path relative to the library root");
		const absolutePath = resolve(this.root, ...relativePath.split("/"));
		this.toRelativePath(absolutePath);
		return absolutePath;
	}

	isLoomPath(absolutePath: string): boolean {
		const value = relative(this.root, resolve(absolutePath));
		return value === ".loom" || value.startsWith(`.loom${sep}`);
	}

	/** Files that are implementation/OS metadata rather than user assets. */
	isIgnoredPath(absolutePath: string): boolean {
		return this.isLoomPath(absolutePath) || basename(absolutePath) === ".DS_Store";
	}
}
