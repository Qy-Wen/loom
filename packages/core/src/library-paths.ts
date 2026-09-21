import { isAbsolute, relative, resolve, sep } from "node:path";

export class LibraryPaths {
	readonly root: string;
	readonly loom: string;
	readonly metadataDb: string;
	readonly graphDb: string;
	readonly thumbnails: string;
	readonly cache: string;

	constructor(rootPath: string) {
		this.root = resolve(rootPath);
		this.loom = resolve(this.root, ".loom");
		this.metadataDb = resolve(this.loom, "metadata.db");
		this.graphDb = resolve(this.loom, "graph.db");
		this.thumbnails = resolve(this.loom, "thumbnails");
		this.cache = resolve(this.loom, "cache");
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
}
