import type { LoomUserAttachment } from "./attachments.ts";

/**
 * Loom's own Agent interface.
 *
 * Business code depends ONLY on this file — never on `@vendor/pi-agent` directly.
 * `pi-adapter.ts` is the single place that translates between this interface and
 * the vendored pi agent. If pi is ever replaced, only the adapter changes.
 */

export type LoomToolContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface LoomToolResult<TDetails = unknown> {
	/** Text or mixed content returned to the model. Images stay as attachments. */
	content: string | LoomToolContentPart[];
	/** Structured UI payload; never injected into the model context. */
	details?: TDetails;
}

export function toolResultText(content: string | LoomToolContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** A tool the agent can call. Loom's own shape, kept minimal. */
export interface LoomTool<TArgs = unknown, TDetails = unknown> {
	name: string;
	description: string;
	/** TypeBox-compatible JSON schema passed through to the underlying engine. */
	parameters: unknown;
	execute: (
		args: TArgs,
		signal?: AbortSignal,
	) => Promise<string | LoomToolResult<TDetails>> | string | LoomToolResult<TDetails>;
}

/** Events Loom surfaces to callers. A deliberately small, engine-agnostic subset. */
export type LoomAgentEvent =
	| { type: "agent_start" }
	| { type: "text"; delta: string }
	| { type: "thinking_start" }
	| { type: "thinking_delta"; delta: string }
	| { type: "thinking_end" }
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; name: string; result: LoomToolResult; isError: boolean }
	| { type: "error"; message: string }
	| { type: "agent_end" };

export type LoomTranscriptMessage = Record<string, unknown> & { role: string };

export interface LoomChatEndpoint {
	baseUrl: string;
	apiKey?: string;
	model: string;
}

export interface LoomAgentOptions {
	systemPrompt?: string;
	/** OpenAI-compatible Chat slot. Missing or incomplete until the user configures Settings. */
	chat?: LoomChatEndpoint;
	tools?: LoomTool[];
	initialMessages?: LoomTranscriptMessage[];
}

export interface LoomPromptOptions {
	attachments?: LoomUserAttachment[];
}

export interface LoomAgent {
	subscribe(listener: (event: LoomAgentEvent) => void): () => void;
	prompt(input: string, options?: LoomPromptOptions): Promise<void>;
	/**
	 * Abort the current run. Idle agents ignore this.
	 * `"user"` means the user pressed Stop; that reason is written into the turn
	 * so the next prompt can tell it from an error.
	 */
	abort(reason?: "user"): void;
	getMessages(): LoomTranscriptMessage[];
	addTools(tools: LoomTool[]): void;
	setSystemPrompt(systemPrompt: string): void;
}
