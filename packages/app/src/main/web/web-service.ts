import type { LoomTool } from "@loom/agent";
import { deepSeekWebProvider } from "./deepseek.ts";
import type { WebProvider } from "./types.ts";
import { createWebTools } from "../tools/web-tools.ts";

/** Tried in order; the first whose Chat provider is enabled with a key serves the Agent. */
export const WEB_PROVIDERS: readonly WebProvider[] = [deepSeekWebProvider];

export interface WebToolsHost {
	/** The General switch. */
	enabled: () => Promise<boolean>;
	/** API key of an enabled Chat provider, or undefined. */
	apiKey: (chatProviderId: string, signal?: AbortSignal) => Promise<string | undefined>;
}

/** Decides which vendor, if any, backs the web tools, and notices when that changes. */
export class WebToolsService {
	readonly #providers: readonly WebProvider[];
	readonly #host: WebToolsHost;
	readonly #built = new Map<string, LoomTool[]>();
	#offered: string | undefined;

	constructor(host: WebToolsHost, providers: readonly WebProvider[] = WEB_PROVIDERS) {
		this.#host = host; this.#providers = providers;
	}

	/** Tools to register now. Also records which vendor they belong to. */
	async tools(): Promise<LoomTool[]> {
		const provider = await this.#select();
		this.#offered = provider?.id;
		if (!provider) return [];
		let tools = this.#built.get(provider.id);
		if (!tools) {
			tools = createWebTools(provider, (signal) => this.#host.apiKey(provider.chatProviderId, signal));
			this.#built.set(provider.id, tools);
		}
		return tools;
	}

	/** True when the vendor behind the registered tools differs from what would be offered now. */
	async changed(): Promise<boolean> {
		return (await this.#select())?.id !== this.#offered;
	}

	async #select(): Promise<WebProvider | undefined> {
		if (!await this.#host.enabled()) return undefined;
		for (const provider of this.#providers) {
			if (await this.#host.apiKey(provider.chatProviderId)) return provider;
		}
		return undefined;
	}
}
