/** Loom-owned tool and Chat configuration contracts; native runtime handles live in durable.ts. */

export type LoomToolContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface LoomToolResult<TDetails = unknown> {
	/** Shared adapter preserves text/images and serializes other content blocks as text. */
	content: string | (LoomToolContentPart | Record<string, unknown>)[];
	/** Structured UI payload; never injected into the model context. */
	details?: TDetails;
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
