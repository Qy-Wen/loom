import { stat } from "node:fs/promises";
import { JsonFile } from "../storage/file.ts";

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

type LastLibraryFile = { rootPath: string | null };

export class LastLibraryStore {
	private readonly file: JsonFile<LastLibraryFile>;
	private rootPath: string | null = null;
	private loaded = false;

	constructor(filePath: string) {
		this.file = new JsonFile(filePath, (value) => ({ rootPath: parseLastLibrary(value) }), { recoverCorrupt: true });
	}

	async load(): Promise<string | null> {
		if (this.loaded) return this.rootPath;
		this.rootPath = (await this.file.read())?.rootPath ?? null;
		this.loaded = true;
		return this.rootPath;
	}

	async remember(rootPath: string): Promise<void> {
		const next = rootPath.trim();
		this.rootPath = next.length > 0 ? next : null;
		this.loaded = true;
		const value = { rootPath: this.rootPath };
		await this.file.update(async () => ({ value, result: undefined }));
	}
}
