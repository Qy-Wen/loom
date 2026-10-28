import { randomUUID } from "node:crypto";
import { JsonFile } from "../storage/file.ts";
import { SerialQueue } from "../storage/serial-queue.ts";
import { DEFAULT_PROCESS_SANDBOX, parseProcessSandboxEnabled, type ProcessSandboxNotice } from "../../shared/agent-sandbox.ts";

type SandboxSettings = { enabled: boolean; notice?: ProcessSandboxNotice };
const defaults = (): SandboxSettings => ({ enabled: DEFAULT_PROCESS_SANDBOX });
function parseSandbox(value: unknown): SandboxSettings {
	const row = value && typeof value === "object" ? value as Partial<SandboxSettings> : undefined;
	const notice = row?.notice;
	return {
		enabled: parseProcessSandboxEnabled(row ? row.enabled : value),
		...(notice && typeof notice.id === "string" && typeof notice.reason === "string" ? { notice } : {}),
	};
}

export class AgentSandboxStore {
	private readonly file: JsonFile<SandboxSettings>;
	private readonly operations = new SerialQueue();
	private last = defaults();
	// A sandbox failure must disable execution even when persistence itself fails.
	private fallback: SandboxSettings | undefined;

	constructor(filePath: string) { this.file = new JsonFile(filePath, parseSandbox, { recoverCorrupt: true }); }

	private async read(): Promise<SandboxSettings> {
		this.last = this.fallback ?? await this.file.read() ?? defaults();
		return this.last;
	}

	private async write(change: (current: SandboxSettings) => SandboxSettings): Promise<SandboxSettings> {
		const saved = await this.file.update(async (current) => {
			const value = change(this.fallback ?? current ?? defaults());
			return { value, result: value };
		});
		this.last = saved;
		this.fallback = undefined;
		return saved;
	}

	load(): Promise<boolean> {
		return this.operations.run(async () => (await this.read()).enabled);
	}

	save(enabled: boolean): Promise<boolean> {
		return this.operations.run(async () => (await this.write((current) => ({ ...current, enabled }))).enabled);
	}

	recordFailure(reason: string): Promise<void> {
		const notice = { id: randomUUID(), reason };
		return this.operations.run(async () => {
			try { await this.write((current) => ({ ...current, enabled: false, notice })); }
			catch (error) {
				this.fallback = { ...this.last, enabled: false, notice };
				throw error;
			}
		});
	}

	pendingNotice(): Promise<ProcessSandboxNotice | null> {
		return this.operations.run(async () => (await this.read()).notice ?? null);
	}

	acknowledgeNotice(id: string): Promise<void> {
		return this.operations.run(async () => {
			await this.write((current) => {
				if (current.notice?.id !== id) return current;
				const { notice: _notice, ...next } = current;
				return next;
			});
		});
	}
}
