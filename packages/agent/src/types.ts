/**
 * Loom's own Agent interface.
 *
 * Business code depends ONLY on this file — never on `@vendor/pi-agent` directly.
 * `pi-adapter.ts` is the single place that translates between this interface and
 * the vendored pi agent. If pi is ever replaced, only the adapter changes.
 */

export interface LoomToolResult<TDetails = unknown> {
	/** Concise text returned to the model. */
	content: string;
	/** Structured UI payload; never injected into the model context. */
	details?: TDetails;
}

/** A tool the agent can call. Loom's own shape, kept minimal. */
export interface LoomTool<TArgs = unknown, TDetails = unknown> {
	name: string;
	description: string;
	/** TypeBox-compatible JSON schema passed through to the underlying engine. */
	parameters: unknown;
	execute: (args: TArgs) => Promise<string | LoomToolResult<TDetails>> | string | LoomToolResult<TDetails>;
}

/** Events Loom surfaces to callers. A deliberately small, engine-agnostic subset. */
export type LoomAgentEvent =
	| { type: "agent_start" }
	| { type: "text"; delta: string }
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; name: string; result: LoomToolResult; isError: boolean }
	| { type: "agent_end" };

export type LoomTranscriptMessage = Record<string, unknown> & { role: string };

export interface LoomAgentOptions {
	systemPrompt?: string;
	/** Provider id + model id, e.g. { provider: "deepseek", model: "deepseek-flash" }. */
	model: { provider: string; model: string };
	tools?: LoomTool[];
	initialMessages?: LoomTranscriptMessage[];
}

export interface LoomAgent {
	subscribe(listener: (event: LoomAgentEvent) => void): () => void;
	prompt(input: string): Promise<void>;
	getMessages(): LoomTranscriptMessage[];
}
