import type { McpServiceSettings, McpServiceView } from "../../shared/mcp-service.ts";
import { SerialQueue } from "../storage/serial-queue.ts";
import { startMcpService, type McpServiceHost } from "./server.ts";
import { McpServiceStore } from "./store.ts";

export class McpServiceController {
	readonly store: McpServiceStore;
	readonly host: Omit<McpServiceHost, "onTasks">;
	readonly changed: (view: McpServiceView) => void;
	readonly queue = new SerialQueue();
	private config: McpServiceSettings = { enabled: false, port: 19441, token: "" };
	private service?: Awaited<ReturnType<typeof startMcpService>>;
	private tasks: McpServiceView["tasks"] = [];
	private error?: string;
	constructor(store: McpServiceStore, host: Omit<McpServiceHost, "onTasks">, changed: (view: McpServiceView) => void) { this.store = store; this.host = host; this.changed = changed; }
	view(): McpServiceView { return { ...this.config, url: this.service?.url ?? `http://127.0.0.1:${this.config.port}/mcp`, running: !!this.service, ...(this.error ? { error: this.error } : {}), tasks: structuredClone(this.tasks) }; }
	async initialize(): Promise<void> { try { this.config = await this.store.load(); await this.restart(); } catch (error) { this.fail(error); } }
	save(settings: McpServiceSettings): Promise<McpServiceView> {
		return this.queue.run(async () => { this.config = await this.store.save(settings); await this.restart(); return this.view(); });
	}
	cancel(id: string): boolean { return this.service?.cancel(id) ?? false; }
	invalidate(): Promise<void> { return this.service?.invalidate() ?? Promise.resolve(); }
	close(): Promise<void> { return this.queue.run(async () => { await this.service?.close(); this.service = undefined; }); }
	private fail(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); this.changed(this.view()); }
	private async restart(): Promise<void> {
		await this.service?.close(); this.service = undefined; this.error = undefined;
		try {
			if (this.config.enabled) this.service = await startMcpService({ ...this.host, onTasks: (tasks) => { this.tasks = tasks; this.changed(this.view()); } }, this.config);
		} catch (error) { this.fail(error); }
		this.changed(this.view());
	}
}
