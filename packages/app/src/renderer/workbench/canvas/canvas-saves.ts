import type { CanvasDocument } from "../../../shared/canvas.ts";

const pendingSaves = new Map<string, CanvasSave>();
const SAVE_DELAY = 240;

export class CanvasSave {
	readonly id: string;
	revision: string;
	pending: CanvasDocument | null = null;
	error: string | null = null;
	conflict = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private saving: Promise<void> | undefined;
	private listeners = new Set<() => void>();

	constructor(id: string, revision: string) {
		this.id = id;
		this.revision = revision;
	}

	subscribe(callback: () => void): () => void {
		this.listeners.add(callback);
		return () => { this.listeners.delete(callback); };
	}

	enqueue(document: CanvasDocument): void {
		this.pending = document;
		if (!pendingSaves.size) window.loom.setCanvasDirty(true);
		pendingSaves.set(this.id, this);
		if (this.error) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, SAVE_DELAY);
		this.publish();
	}

	flush(): Promise<void> {
		clearTimeout(this.timer);
		if (this.conflict) return Promise.reject(new Error(this.error ?? "Canvas changed on disk"));
		if (this.saving) return this.saving.then(() => this.pending ? this.flush() : undefined);
		if (!this.pending) return Promise.resolve();
		this.error = null;
		this.saving = this.writePending().catch((cause) => {
			this.error = cause instanceof Error ? cause.message : String(cause);
			throw cause;
		}).finally(() => {
			this.saving = undefined;
			if (!this.pending) this.clearPending();
			this.publish();
		});
		this.publish();
		return this.saving;
	}

	reset(revision: string): void {
		clearTimeout(this.timer);
		this.revision = revision;
		this.pending = null;
		this.conflict = false;
		this.error = null;
		this.clearPending();
		this.publish();
	}

	private async writePending(): Promise<void> {
		while (this.pending) {
			const document = this.pending;
			const saved = await window.loom.saveCanvas(this.id, document, this.revision);
			if (!saved) {
				this.conflict = true;
				throw new Error("Canvas changed on disk");
			}
			this.revision = saved.revision;
			if (document === this.pending) this.pending = null;
		}
	}

	private publish(): void {
		for (const listener of this.listeners) listener();
	}

	private clearPending(): void {
		if (pendingSaves.get(this.id) === this && pendingSaves.delete(this.id) && !pendingSaves.size) window.loom.setCanvasDirty(false);
	}
}

export function pendingCanvasSave(id: string): CanvasSave | undefined {
	return pendingSaves.get(id);
}

export async function flushCanvasSaves(): Promise<void> {
	await Promise.all([...pendingSaves.values()].map((save) => save.flush()));
}

export function pruneCanvasSaves(canvasIds: ReadonlySet<string>): void {
	for (const [id, save] of pendingSaves) if (!canvasIds.has(id)) save.reset(save.revision);
}
