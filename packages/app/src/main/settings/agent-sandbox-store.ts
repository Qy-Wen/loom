import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PROCESS_SANDBOX, parseProcessSandboxEnabled, type ProcessSandboxNotice } from "../../shared/agent-sandbox.ts";

export class AgentSandboxStore {
	private readonly filePath: string;
	private enabled = DEFAULT_PROCESS_SANDBOX;
	private loaded = false;
	private notice: ProcessSandboxNotice | null = null;
	private writes: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<boolean> {
		if (this.loaded) return this.enabled;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			const raw = parsed && typeof parsed === "object" ? (parsed as { enabled?: unknown }).enabled : parsed;
			this.enabled = parseProcessSandboxEnabled(raw);
			const notice = parsed && typeof parsed === "object" ? (parsed as { notice?: unknown }).notice : undefined;
			if (notice && typeof notice === "object" && "id" in notice && typeof notice.id === "string" && "reason" in notice && typeof notice.reason === "string") {
				this.notice = { id: notice.id, reason: notice.reason };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.enabled = DEFAULT_PROCESS_SANDBOX;
		}
		this.loaded = true;
		return this.enabled;
	}

	async save(enabled: boolean): Promise<boolean> {
		await this.load();
		this.enabled = enabled;
		await this.persist();
		return this.enabled;
	}

	async recordFailure(reason: string): Promise<void> {
		await this.load();
		this.enabled = false;
		this.notice = { id: randomUUID(), reason };
		await this.persist();
	}

	async pendingNotice(): Promise<ProcessSandboxNotice | null> {
		await this.load();
		return this.notice;
	}

	async acknowledgeNotice(id: string): Promise<void> {
		await this.load();
		if (this.notice?.id !== id) return;
		this.notice = null;
		await this.persist();
	}

	private persist(): Promise<void> {
		const data = JSON.stringify({ enabled: this.enabled, ...(this.notice ? { notice: this.notice } : {}) }, null, "\t");
		// Settings saves, fallback and renderer acknowledgements can overlap.
		const write = this.writes.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFile(this.filePath, `${data}\n`, "utf8");
		});
		this.writes = write.catch(() => undefined);
		return write;
	}
}
