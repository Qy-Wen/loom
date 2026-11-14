import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type { LoomTool } from "../types.ts";
import { ToolCatalog } from "./catalog.ts";

/** One opening of a library; a binding must never follow a later library switch. */
export interface ToolLibraryBinding {
	run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface ExternalToolCall {
	name: string;
	args: Record<string, unknown>;
}

type ExecutionOptions = {
	library?: ToolLibraryBinding;
	signal?: AbortSignal;
} & (
	/** Durable's permission hook authorizes trusted Agent calls before this entry. */
	{ audience: "agent" }
	| {
		audience: "external";
		/** The transport host supplies identity/approval; a remote caller cannot supply this function. */
		authorize: (call: ExternalToolCall, signal?: AbortSignal) => Promise<void>;
	}
);

/** Shared admission and execution. Protocol adapters own identities and result encoding. */
export class ToolExecutor {
	readonly catalog: ToolCatalog;

	constructor(catalog: ToolCatalog) { this.catalog = catalog; }

	/** These wrappers are only for the trusted Agent adapter with its ToolTask permission hook. */
	agentTools(bindLibrary: () => ToolLibraryBinding): LoomTool[] {
		return this.catalog.list("agent").map(({ tool, scope }) => ({
			...tool,
			execute: (args, signal) => this.execute(tool.name, args, {
				audience: "agent", signal,
				...(scope === "library" ? { library: bindLibrary() } : {}),
			}),
		}));
	}

	async execute(name: string, args: unknown, options: ExecutionOptions) {
		options.signal?.throwIfAborted();
		const { tool, scope } = this.catalog.get(name, options.audience);
		const input = args === undefined ? {} : args;
		if (!input || typeof input !== "object" || Array.isArray(input) || !Value.Check((tool.parameters ?? { type: "object" }) as TSchema, input)) {
			// Do not include argument values: settings arguments can contain credentials.
			throw new TypeError(`Invalid arguments for tool: ${name}`);
		}
		if (options.audience === "external" && typeof options.authorize !== "function") {
			throw new Error("External tool calls require authorization");
		}
		const invoke = async (signal?: AbortSignal) => {
			signal?.throwIfAborted();
			if (options.audience === "external") await options.authorize({ name, args: input as Record<string, unknown> }, signal);
			signal?.throwIfAborted();
			const result = await tool.execute(input, signal);
			signal?.throwIfAborted();
			return typeof result === "string" || result.data === undefined ? result : {
				...result, data: copyJson(result.data as JsonValue, { omitUndefinedProperties: true }),
			};
		};
		if (scope === "application") return invoke(options.signal);
		if (!options.library) throw new Error("A library binding is required");
		return options.library.run(invoke, options.signal);
	}
}
