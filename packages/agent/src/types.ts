/** Loom-owned tool and Chat configuration contracts; native runtime handles live in durable.ts. */

export type LoomToolContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface LoomToolResult<TData = unknown> {
	/** Shared adapter preserves text/images and serializes other content blocks as text. */
	content: string | (LoomToolContentPart | Record<string, unknown>)[];
	/** Structured business result shared by Agent, MCP and HTTP adapters. */
	data?: TData;
	/** Structured UI payload; never injected into the model context. */
	details?: unknown;
}

/** A tool the agent can call. Loom's own shape, kept minimal. */
export interface LoomTool<TArgs = unknown, TData = unknown> {
	name: string;
	description: string;
	/** TypeBox-compatible JSON schema passed through to the underlying engine. */
	parameters: unknown;
	execute: (
		args: TArgs,
		signal?: AbortSignal,
	) => Promise<string | LoomToolResult<TData>> | string | LoomToolResult<TData>;
}

export type LoomTranscriptMessage = Record<string, unknown> & { role: string };

export interface LoomAgentOptions {
	systemPrompt?: string;
	/** Loom-owned tools; native workspace tools are installed by the library extension. */
	tools?: LoomTool[];
}
