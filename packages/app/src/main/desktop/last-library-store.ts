import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function parseLastLibrary(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const rootPath = (value as { rootPath?: unknown }).rootPath;
	if (typeof rootPath !== "string") return null;
	const trimmed = rootPath.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export async function lastLibraryStillOpenable(rootPath: string): Promise<boolean> {
	try {
		return (await stat(rootPath)).isDirectory();
	} catch {
		return false;
	}
}

export class LastLibraryStore {
	private readonly filePath: string;
	private rootPath: string | null = null;
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<string | null> {
		if (this.loaded) return this.rootPath;
		try {
			this.rootPath = parseLastLibrary(JSON.parse(await readFile(this.filePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.rootPath = null;
		}
		this.loaded = true;
		return this.rootPath;
	}

	async remember(rootPath: string): Promise<void> {
		const next = rootPath.trim();
		this.rootPath = next.length > 0 ? next : null;
		this.loaded = true;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify({ rootPath: this.rootPath }, null, "\t")}\n`, "utf8");
	}
}
