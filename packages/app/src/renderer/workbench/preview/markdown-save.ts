import type { MarkdownSaveResult, MarkdownSnapshot } from "../../../shared/markdown-file.ts";
import { addPendingSave, removePendingSave, type PendingSave } from "../pending-saves.ts";

/** The two calls to the main process a save needs, so a test can stand in for them. */
export interface MarkdownFiles {
	read(assetId: string): Promise<MarkdownSnapshot>;
	save(assetId: string, text: string, revision: string): Promise<MarkdownSaveResult>;
}

export const MARKDOWN_SAVE_DELAY = 1000;

export type MarkdownSaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

/**
 * The editing session of one Markdown file: the text being edited, the revision it was read at, and
 * the saves that carry it back to disk. A save never overwrites a file that changed since the read.
 */
export class MarkdownSave implements PendingSave {
	readonly assetId: string;
	/** The text in the editor. */
	text: string;
	/** The revision of the file the text was last read from or saved to. */
	revision: string;
	state: MarkdownSaveState = "saved";
	error: string | null = null;
	private saved: string;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<void> | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly files: MarkdownFiles;
	private readonly delay: number;

	constructor(assetId: string, snapshot: MarkdownSnapshot, files: MarkdownFiles, delay = MARKDOWN_SAVE_DELAY) {
		this.assetId = assetId;
		this.text = this.saved = snapshot.text;
		this.revision = snapshot.revision;
		this.files = files;
		this.delay = delay;
	}

	/** True while the editor holds text that is not on disk. */
	get dirty(): boolean {
		return this.text !== this.saved;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** The editor's text changed. A save follows once typing pauses. */
	edit(text: string): void {
		this.text = text;
		if (!this.dirty) {
			// Back to what is on disk: nothing to write.
			clearTimeout(this.timer);
			if (this.state === "dirty") this.setState("saved");
			if (!this.running && this.state !== "conflict") removePendingSave(this);
			return;
		}
		addPendingSave(this);
		if (this.state === "conflict") return;
		this.setState(this.running ? "saving" : "dirty");
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, this.delay);
	}

	/** Write what is pending now. Rejects when the file changed on disk or could not be written. */
	flush(): Promise<void> {
		clearTimeout(this.timer);
		if (this.state === "conflict") return Promise.reject(new Error("The file was modified on disk"));
		if (this.running) return this.running.then(() => (this.dirty ? this.flush() : undefined));
		if (!this.dirty) {
			removePendingSave(this);
			return Promise.resolve();
		}
		this.error = null;
		this.setState("saving");
		this.running = this.write().finally(() => {
			this.running = undefined;
			if (!this.dirty && this.state !== "conflict") removePendingSave(this);
		});
		return this.running;
	}

	/**
	 * The file on disk changed outside this session. With nothing unsaved the new content replaces the text
	 * and `true` is returned. With unsaved edits nothing is touched: the next save finds the conflict.
	 */
	external(snapshot: MarkdownSnapshot): boolean {
		if (snapshot.revision === this.revision) return false;
		if (this.dirty || this.running) return false;
		this.adopt(snapshot);
		return true;
	}

	/** Take the file as it is on disk and drop the editor's unsaved text. The "Reload" choice. */
	async reload(): Promise<void> {
		this.adopt(await this.files.read(this.assetId));
	}

	/** Write the editor's text over whatever is on disk. The "Overwrite" choice. */
	async overwrite(): Promise<void> {
		const current = await this.files.read(this.assetId);
		this.revision = current.revision;
		this.saved = current.text;
		this.setState(this.dirty ? "dirty" : "saved");
		await this.flush();
	}

	/** Stop the pending timer. Edits stay in memory and in the pending list until a flush. */
	dispose(): void {
		clearTimeout(this.timer);
		this.listeners.clear();
	}

	private async write(): Promise<void> {
		try {
			while (this.dirty) {
				const text = this.text;
				const result = await this.files.save(this.assetId, text, this.revision);
				if (result.status === "conflict") {
					this.setState("conflict");
					throw new Error("The file was modified on disk");
				}
				this.revision = result.snapshot.revision;
				this.saved = text;
			}
			this.setState("saved");
		} catch (cause) {
			if (this.state !== "conflict") {
				this.error = cause instanceof Error ? cause.message : String(cause);
				this.setState("error");
			}
			throw cause;
		}
	}

	private adopt(snapshot: MarkdownSnapshot): void {
		clearTimeout(this.timer);
		this.text = this.saved = snapshot.text;
		this.revision = snapshot.revision;
		this.error = null;
		removePendingSave(this);
		this.setState("saved");
	}

	private setState(state: MarkdownSaveState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}
