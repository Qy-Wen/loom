import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CloudConfig, CloudPreview, LocalCloudLibrary } from "../../shared/cloud-backup.ts";
import { JsonFile } from "../storage/file.ts";
import type { MirrorManifest } from "./mirror.ts";
import { trackedBackupPath, type Snapshot } from "./snapshot.ts";

type FileStamp = { path: string; size: number; mtimeMs: number };
type Baseline = { scope: string; libraryId: string; updatedAt?: string; files: FileStamp[]; directories: string[]; error?: string; retryOperation?: "backup" | "preview" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function destination(config: CloudConfig): string { return createHash("sha256").update(JSON.stringify(config)).digest("hex"); }
function parseCache(input: unknown): Baseline[] {
	if (!Array.isArray(input)) throw new Error("Invalid local cloud backup cache");
	for (const entry of input as Baseline[]) {
		if (!entry || !/^[a-f0-9]{64}$/.test(entry.scope) || !UUID.test(entry.libraryId)) throw new Error("Invalid cached backup identity");
		if (entry.updatedAt !== undefined && (typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt)))) throw new Error("Invalid cached backup time");
		if (entry.error !== undefined && typeof entry.error !== "string") throw new Error("Invalid cached backup error");
		if (entry.retryOperation !== undefined && entry.retryOperation !== "backup" && entry.retryOperation !== "preview") throw new Error("Invalid cached backup operation");
		if (!Array.isArray(entry.directories) || entry.directories.some((path) => typeof path !== "string") || !Array.isArray(entry.files) || entry.files.some((file) => !file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isFinite(file.mtimeMs))) throw new Error("Invalid cached backup files");
	}
	return input;
}
async function inventory(root: string): Promise<{ files: FileStamp[]; directories: string[] }> {
	const files: FileStamp[] = [], directories: string[] = [];
	async function walk(parent: string) {
		for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
			const path = parent ? `${parent}/${entry.name}` : entry.name;
			if (!trackedBackupPath(path)) continue;
			if (entry.isSymbolicLink()) throw new Error("Library contains a link; preview before backing up");
			if (entry.isDirectory()) { directories.push(path); await walk(path); }
			else { const stat = await lstat(join(root, path)); files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs }); }
		}
	}
	await walk(""); return { files, directories };
}
function sameInventory(a: { files: FileStamp[]; directories: string[] }, b: { files: FileStamp[]; directories: string[] }): boolean {
	if (a.files.length !== b.files.length || a.directories.length !== b.directories.length) return false;
	const files = new Map(a.files.map((file) => [file.path, file]));
	const directories = new Set(a.directories);
	// Metadata staging can round sub-millisecond timestamps. This comparison is only a hint.
	return b.directories.every((path) => directories.has(path)) && b.files.every((file) => { const old = files.get(file.path); return old?.size === file.size && Math.abs(old.mtimeMs - file.mtimeMs) < 1; });
}

/** A disposable local cache plus conservative filesystem hints. Only explicit previews establish content equality. */
export class LocalBackupState {
	readonly #cache: JsonFile<Baseline[]>;
	readonly #changed: () => void;
	#scope = "";
	#epoch = 0;
	#generation = 0;
	#watcher?: FSWatcher;
	#timer?: ReturnType<typeof setTimeout>;
	#view?: LocalCloudLibrary;
	constructor(path: string, changed: () => void) { this.#cache = new JsonFile(path, parseCache, { recoverCorrupt: true }); this.#changed = changed; }
	view(): LocalCloudLibrary | undefined { return this.#view && structuredClone(this.#view); }
	get generation(): number { return this.#generation; }
	async open(root: string | null, config: CloudConfig): Promise<void> {
		this.#watcher?.close(); this.#watcher = undefined; clearTimeout(this.#timer);
		const epoch = ++this.#epoch;
		this.#scope = destination(config); this.#generation++;
		this.#view = root ? { rootPath: root, libraryName: basename(root), status: "never" } : undefined;
		this.#changed();
		if (!root) return;
		try {
			this.#watcher = watch(root, { recursive: true }, (_event, filename) => {
				if (epoch !== this.#epoch) return;
				const path = filename?.toString().replace(/\\/g, "/");
				if (!path || trackedBackupPath(path)) this.invalidate();
			});
			this.#watcher.on("error", () => { if (epoch === this.#epoch) this.invalidate(); });
			let id: string | undefined;
			try { id = JSON.parse(await readFile(join(root, ".loom/backup/identity.json"), "utf8")).id; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (id !== undefined && !UUID.test(id)) throw new Error("Invalid library backup identity");
			const baseline = id ? (await this.#cache.read())?.find((entry) => entry.scope === this.#scope && entry.libraryId === id) : undefined;
			if (epoch !== this.#epoch) return;
			Object.assign(this.#view!, { libraryId: id, lastBackupAt: baseline?.updatedAt, status: baseline?.error ? "failed" : id ? "unchecked" : "never", error: baseline?.error, retryOperation: baseline?.retryOperation });
			if (baseline?.updatedAt && !baseline.error) {
				const current = await inventory(root);
				if (epoch !== this.#epoch) return;
				if (!sameInventory(baseline, current)) this.#view!.status = "changed";
			}
		} catch (error) {
			if (epoch !== this.#epoch) return;
			this.#view!.status = "unchecked"; this.#view!.error = error instanceof Error ? error.message : "Cannot check local library";
		}
		if (epoch === this.#epoch) this.#changed();
	}
	invalidate(): void {
		this.#generation++;
		if (!this.#view) return;
		if (this.#view.status !== "never" && this.#view.status !== "checking" && this.#view.status !== "failed") this.#view.status = "changed";
		if (this.#view.preview) this.#view.preview.stale = true;
		clearTimeout(this.#timer); this.#timer = setTimeout(() => this.#changed(), 200); this.#timer.unref();
	}
	checking(root: string): void { if (this.#view?.rootPath === root) { this.#view.status = "checking"; this.#view.error = undefined; if (this.#view.preview) this.#view.preview.stale = true; this.#changed(); } }
	captured(snapshot: Snapshot): void { if (this.#view?.rootPath === snapshot.root) this.#view.libraryId = snapshot.libraryId; }
	async #remember(scope: string, manifest: MirrorManifest): Promise<void> {
		const baseline: Baseline = { scope, libraryId: manifest.library.libraryId, updatedAt: manifest.library.updatedAt, files: manifest.files.map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs })), directories: manifest.directories };
		await this.#cache.update(async (entries = []) => ({ value: [...entries.filter((entry) => entry.scope !== scope || entry.libraryId !== baseline.libraryId), baseline], result: undefined }));
	}
	async preview(snapshot: Snapshot, preview: CloudPreview, baseline: MirrorManifest | undefined, generation: number, scope: CloudConfig): Promise<void> {
		if (baseline) await this.#remember(destination(scope), baseline);
		else await this.#cache.update(async (entries = []) => ({
			value: entries.some((entry) => entry.scope === destination(scope) && entry.libraryId === snapshot.libraryId && entry.error)
				? entries.map((entry) => entry.scope === destination(scope) && entry.libraryId === snapshot.libraryId ? { ...entry, error: undefined, retryOperation: undefined } : entry) : undefined,
			result: undefined,
		}));
		if (this.#view?.rootPath !== snapshot.root || this.#scope !== destination(scope)) return;
		preview.stale = generation !== this.#generation;
		Object.assign(this.#view, { libraryId: snapshot.libraryId, lastBackupAt: baseline?.library.updatedAt ?? this.#view.lastBackupAt, preview, status: preview.stale || preview.changes.length > 0 || preview.repair ? "changed" : "current", error: undefined, retryOperation: undefined });
		this.#changed();
	}
	async backedUp(snapshot: Snapshot, manifest: MirrorManifest, generation: number, scope: CloudConfig): Promise<void> {
		await this.#remember(destination(scope), manifest);
		if (this.#view?.rootPath !== snapshot.root || this.#scope !== destination(scope)) return;
		Object.assign(this.#view, { libraryId: snapshot.libraryId, lastBackupAt: manifest.library.updatedAt, preview: undefined, status: generation === this.#generation ? "current" : "changed", error: undefined, retryOperation: undefined });
		this.#changed();
	}
	async failed(root: string, error?: string, id?: string, retryOperation?: "backup" | "preview"): Promise<void> {
		const scope = this.#scope;
		if (this.#view?.rootPath === root) {
			id ??= this.#view.libraryId;
			this.#view.status = error ? "failed" : "unchecked"; this.#view.error = error; this.#view.retryOperation = error ? retryOperation : undefined;
			if (this.#view.preview) this.#view.preview.stale = true;
			this.#changed();
		}
		if (id) await this.#cache.update(async (entries = []) => {
			const old = entries.find((entry) => entry.scope === scope && entry.libraryId === id);
			return { value: [...entries.filter((entry) => entry !== old), { scope, libraryId: id, files: [], directories: [], ...old, error, retryOperation: error ? retryOperation : undefined }], result: undefined };
		});
	}
	close(): void { this.#epoch++; clearTimeout(this.#timer); this.#watcher?.close(); this.#watcher = undefined; }
}
