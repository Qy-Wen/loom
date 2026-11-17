import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { CloudLibrary, CloudBackupView, CloudConfigDraft, CloudJob } from "../../shared/cloud-backup.ts";
import type { CloudConfigStore } from "./config.ts";
import type { ObjectStoreFactory } from "./providers.ts";
import type { ObjectStore } from "./object-store.ts";
import type { Snapshot } from "./snapshot.ts";
import { listCloudLibraries, restoreMirror, updateMirror } from "./mirror.ts";
import { SerialQueue } from "../storage/serial-queue.ts";

type Host = { capture(signal: AbortSignal): Promise<Snapshot>; pickRestoreParent(): Promise<string | undefined>; openRestored(path: string): Promise<void> };
/** One app-owned job at a time. Network work continues after the settings panel is closed. */
export class CloudBackupController {
	readonly #settings: CloudConfigStore;
	readonly #host: Host;
	readonly #changed: (view: CloudBackupView) => void;
	readonly #factory: ObjectStoreFactory;
	readonly #settingsQueue = new SerialQueue();
	#libraries: CloudLibrary[] = [];
	#job?: CloudJob;
	#abort?: AbortController;
	#work?: Promise<void>;
	#closed = false;
	constructor(settings: CloudConfigStore, host: Host, changed: (view: CloudBackupView) => void, factory: ObjectStoreFactory) {
		this.#settings = settings; this.#host = host; this.#changed = changed; this.#factory = factory;
	}
	async view(): Promise<CloudBackupView> { return { ...await this.#settings.view(), libraries: this.#libraries.map((r) => ({ ...r })), job: this.#job && { ...this.#job } }; }
	configuration(): Promise<CloudConfigDraft> { return this.#settings.configuration(); }
	async save(draft: CloudConfigDraft): Promise<CloudBackupView> {
		return this.#settingsQueue.run(async () => {
			this.#assertIdle();
			await this.#settings.save(draft); this.#libraries = []; this.#job = undefined;
			const view = await this.view(); this.#changed(view); return view;
		});
	}
	#assertIdle() { if (this.#closed) throw new Error("Cloud backup is closing"); if (this.#abort) throw new Error("A cloud operation is already running"); }
	async start(operation: CloudJob["operation"], libraryId?: string): Promise<void> {
		await this.#settingsQueue.run(async () => {
			this.#assertIdle();
			const store = this.#factory(await this.#settings.load());
			const config = await this.#settings.view();
			this.#assertIdle();
			const library = operation === "restore" ? this.#libraries.find((r) => r.libraryId === libraryId) : undefined;
			if (operation === "restore" && (!library || library.state !== "ready")) throw new Error("Refresh cloud libraries and choose a completed copy before restoring");
			const abort = new AbortController(); this.#abort = abort;
			this.#job = { operation, status: "running", phase: operation === "backup" ? "snapshot" : operation === "restore" ? "download" : operation, completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
			// Capture the public configuration once. No credentials are sent to renderer events.
			let lastEvent = 0;
			const publish = (force = false) => {
				if (!force && Date.now() - lastEvent < 100) return;
				lastEvent = Date.now(); this.#changed({ ...config, libraries: [...this.#libraries], job: this.#job && { ...this.#job } });
			};
			publish(true);
			this.#work = (async () => {
				try {
					const progress = (patch: Partial<CloudJob>) => { Object.assign(this.#job!, patch); publish(); };
					if (operation === "backup") {
						const snapshot = await this.#host.capture(abort.signal);
						await updateMirror(snapshot, store, hostname(), abort.signal, progress, (next) => {
							this.#libraries = [next, ...this.#libraries.filter((item) => item.libraryId !== next.libraryId)]; publish(true);
						});
					} else if (operation === "restore") {
						const parent = await this.#host.pickRestoreParent();
						if (!parent) { abort.abort(); abort.signal.throwIfAborted(); }
						this.#job!.restoredPath = await restoreMirror(library!.libraryId, parent!, store, abort.signal, progress);
					} else if (operation === "list") this.#libraries = await listCloudLibraries(store, abort.signal);
					else await this.#test(store, abort.signal);
					this.#job!.status = "completed";
				} catch (error) {
					this.#job!.status = abort.signal.aborted ? "cancelled" : "failed";
					if (!abort.signal.aborted) this.#job!.error = error instanceof Error ? error.message : "Cloud operation failed";
				} finally { this.#abort = undefined; publish(true); }
			})();
		});
	}
	cancel(): void { this.#abort?.abort(); }
	async openRestored(): Promise<void> {
		this.#assertIdle();
		if (this.#job?.status !== "completed" || !this.#job.restoredPath) throw new Error("Restore a backup first");
		await this.#host.openRestored(this.#job.restoredPath);
	}
	async close(): Promise<void> { this.#closed = true; this.cancel(); await this.#settingsQueue.run(async () => {}); this.cancel(); await this.#work; }
	async #test(store: ObjectStore, signal: AbortSignal): Promise<void> {
		const temporary = await mkdtemp(join(tmpdir(), "loom-cloud-test-"));
		try {
			// Validate listing, upload, read and delete with a private per-test probe.
			for await (const _key of store.list(".loom/libraries/", signal)) break;
			const probeKey = `connection-test/${randomUUID()}.txt`;
			const probe = Buffer.from("Loom cloud connection test v1\n");
			const source = join(temporary, randomUUID()), target = join(temporary, randomUUID());
			await writeFile(source, probe);
			await store.upload(probeKey, source, signal);
			if (!await store.head(probeKey, signal)) throw new Error("Cloud connection test object is missing");
			await store.download(probeKey, target, signal, 1024);
			if (!probe.equals(await readFile(target))) throw new Error("Cloud connection test content mismatch");
			await store.remove(probeKey, signal);
		} finally { await rm(temporary, { recursive: true, force: true }); }
	}
}
