import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { CloudLibrary, CloudBackupView, CloudConfigDraft, CloudJob } from "../../shared/cloud-backup.ts";
import type { CloudConfigStore } from "./config.ts";
import type { ObjectStoreFactory } from "./providers.ts";
import type { ObjectStore } from "./object-store.ts";
import { snapshotSourcesUnchanged, type Snapshot } from "./snapshot.ts";
import { listCloudLibraries, restoreMirror, updateMirror, type MirrorManifest } from "./mirror.ts";
import { previewMirror } from "./preview.ts";
import { LocalBackupState } from "./local-state.ts";
import { SerialQueue } from "../storage/serial-queue.ts";

type Host = { capture(signal: AbortSignal): Promise<Snapshot>; pickRestoreParent(): Promise<string | undefined>; openRestored(path: string): Promise<void> };
/** One app-owned job at a time. Network work continues after the settings panel is closed. */
export class CloudBackupController {
	readonly #settings: CloudConfigStore;
	readonly #host: Host;
	readonly #changed: (view: CloudBackupView) => void;
	readonly #factory: ObjectStoreFactory;
	readonly #settingsQueue = new SerialQueue();
	readonly #local?: LocalBackupState;
	#libraries: CloudLibrary[] = [];
	#job?: CloudJob;
	#abort?: AbortController;
	#work?: Promise<void>;
	#closed = false;
	constructor(settings: CloudConfigStore, host: Host, changed: (view: CloudBackupView) => void, factory: ObjectStoreFactory, statePath?: string) {
		this.#settings = settings; this.#host = host; this.#changed = changed; this.#factory = factory;
		if (statePath) this.#local = new LocalBackupState(statePath, () => { void this.view().then((view) => { if (!this.#closed) this.#changed(view); }).catch(() => {}); });
	}
	async view(): Promise<CloudBackupView> { return { ...await this.#settings.view(), libraries: this.#libraries.map((r) => ({ ...r })), localLibrary: this.#local?.view(), job: this.#job && { ...this.#job } }; }
	async openLibrary(root: string | null): Promise<void> {
		if (root) root = await realpath(root);
		if (this.#closed || !this.#local || this.#local.view()?.rootPath === root) return;
		await this.#local.open(root, (await this.#settings.view()).config);
	}
	configuration(): Promise<CloudConfigDraft> { return this.#settings.configuration(); }
	async save(draft: CloudConfigDraft): Promise<CloudBackupView> {
		return this.#settingsQueue.run(async () => {
			this.#assertIdle();
			await this.#settings.save(draft); this.#libraries = []; this.#job = undefined;
			if (this.#local) await this.#local.open(this.#local.view()?.rootPath ?? null, (await this.#settings.view()).config);
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
			this.#job = { operation, rootPath: operation === "backup" || operation === "preview" ? this.#local?.view()?.rootPath : undefined, status: "running", phase: operation === "backup" || operation === "preview" ? "snapshot" : operation === "restore" ? "download" : operation, completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
			// Capture the public configuration once. No credentials are sent to renderer events.
			let lastEvent = 0;
			const publish = (force = false) => {
				if (!force && Date.now() - lastEvent < 100) return;
				lastEvent = Date.now(); this.#changed({ ...config, libraries: [...this.#libraries], localLibrary: this.#local?.view(), job: this.#job && { ...this.#job } });
			};
			publish(true);
			this.#work = (async () => {
				try {
					const progress = (patch: Partial<CloudJob>) => { Object.assign(this.#job!, patch); publish(); };
					if (operation === "backup" || operation === "preview") {
						if (this.#job!.rootPath) this.#local?.checking(this.#job!.rootPath);
						const snapshot = await this.#host.capture(abort.signal);
						this.#job!.rootPath = snapshot.root;
						this.#job!.libraryId = snapshot.libraryId; this.#local?.captured(snapshot);
						const generation = this.#local?.generation ?? 0;
						if (operation === "preview") {
							try {
								const { preview, baseline } = await previewMirror(snapshot, store, abort.signal, progress);
								if (!await snapshotSourcesUnchanged(snapshot, abort.signal) && this.#local?.view()?.rootPath === snapshot.root) this.#local.invalidate();
								await this.#local?.preview(snapshot, preview, baseline, generation, config.config);
							} finally { await rm(snapshot.temporary, { recursive: true, force: true, maxRetries: 3 }); }
						} else {
							let manifest: MirrorManifest | undefined;
							await updateMirror(snapshot, store, hostname(), abort.signal, progress, (next) => {
								this.#libraries = [next, ...this.#libraries.filter((item) => item.libraryId !== next.libraryId)]; publish(true);
							}, (next) => { manifest = next; });
							if (!await snapshotSourcesUnchanged(snapshot, abort.signal) && this.#local?.view()?.rootPath === snapshot.root) this.#local.invalidate();
							await this.#local?.backedUp(snapshot, manifest!, generation, config.config);
						}
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
					if ((operation === "backup" || operation === "preview") && this.#job!.rootPath) {
						try { await this.#local?.failed(this.#job!.rootPath, this.#job!.error, this.#job!.libraryId, operation); }
						catch { this.#job!.error = `${this.#job!.error ?? "Cloud operation cancelled"}; local backup status could not be saved`; }
					}
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
	async close(): Promise<void> { this.#closed = true; this.#local?.close(); this.cancel(); await this.#settingsQueue.run(async () => {}); this.cancel(); await this.#work; }
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
