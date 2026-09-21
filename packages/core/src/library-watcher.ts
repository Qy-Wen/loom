import chokidar, { type FSWatcher } from "chokidar";
import type { LibraryPaths } from "./library-paths.ts";

export type LibraryFileEvent =
	| { type: "upsert"; absolutePath: string }
	| { type: "remove"; absolutePath: string }
	| { type: "folder_upsert"; absolutePath: string }
	| { type: "folder_remove"; absolutePath: string }
	| { type: "error"; error: Error };

/** Converts chokidar callbacks into Loom's small, filesystem-only event set. */
export class LibraryWatcher {
	private watcher: FSWatcher | null = null;
	private readonly paths: LibraryPaths;

	constructor(paths: LibraryPaths) {
		this.paths = paths;
	}

	async start(listener: (event: LibraryFileEvent) => void): Promise<void> {
		if (this.watcher) throw new Error("Library watcher is already running");

		const watcher = chokidar.watch(this.paths.root, {
			ignored: (path) => this.paths.isIgnoredPath(path),
			ignoreInitial: true,
			followSymlinks: false,
			awaitWriteFinish: {
				stabilityThreshold: 150,
				pollInterval: 50,
			},
		});
		this.watcher = watcher;

		watcher.on("add", (absolutePath) => listener({ type: "upsert", absolutePath }));
		watcher.on("change", (absolutePath) => listener({ type: "upsert", absolutePath }));
		watcher.on("unlink", (absolutePath) => listener({ type: "remove", absolutePath }));
		watcher.on("addDir", (absolutePath) => listener({ type: "folder_upsert", absolutePath }));
		watcher.on("unlinkDir", (absolutePath) => listener({ type: "folder_remove", absolutePath }));
		watcher.on("error", (error) =>
			listener({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }),
		);

		await new Promise<void>((resolve, reject) => {
			watcher.once("ready", resolve);
			watcher.once("error", reject);
		});
	}

	async close(): Promise<void> {
		const watcher = this.watcher;
		this.watcher = null;
		if (watcher) await watcher.close();
	}
}
