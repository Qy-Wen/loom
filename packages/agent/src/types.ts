/**
 * Loom's own Agent interface.
 *
 * Business code depends ONLY on this file — never on `@vendor/pi-agent` directly.
 * `pi-adapter.ts` is the single place that translates between this interface and
 * the vendored pi agent. If pi is ever replaced, only the adapter changes.
 */

/** A tool the agent can call. Loom's own shape, kept minimal. */
export interface LoomTool<TArgs = unknown> {
	name: string;
	description: string;
	/** JSON-schema-ish parameter definition (passed through to the underlying engine). */
	parameters: unknown;
	execute: (args: TArgs) => Promise<string> | string;
}

/** Events Loom surfaces to callers. A deliberately small, engine-agnostic subset. */
export type LoomAgentEvent =
	| { type: "agent_start" }
	| { type: "text"; delta: string }
	| { type: "tool_start"; name: string; args: unknown }
	| { type: "tool_end"; name: string; result: unknown }
	| { type: "agent_end" };

export interface LoomAgentOptions {
	systemPrompt?: string;
	/** Provider id + model id, e.g. { provider: "deepseek", model: "deepseek-flash" }. */
	model: { provider: string; model: string };
	tools?: LoomTool[];
}

export interface LoomAgent {
	subscribe(listener: (event: LoomAgentEvent) => void): () => void;
	prompt(input: string): Promise<void>;
}
