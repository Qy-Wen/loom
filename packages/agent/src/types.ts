/**
 * Loom's own Agent interface.
 *
 * Application code depends on this small boundary, never on the vendored
 * harness session or tool types directly.
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

export type LoomTranscriptMessage = Record<string, unknown> & { role: string };

export interface LoomChatEndpoint {
	baseUrl: string;
	apiKey?: string;
	model: string;
	/** Model context window in tokens; defaults to 128k when unset. */
	contextWindow?: number;
}

export interface LoomAgentOptions {
	systemPrompt?: string;
	/** OpenAI-compatible Chat slot. Missing or incomplete until the user configures Settings. */
	chat?: LoomChatEndpoint;
	/** Loom-owned tools; native workspace tools are installed by the library extension. */
	tools?: LoomTool[];
}
