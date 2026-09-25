/**
 * Vendor boundary with `pi-tools.ts`. Everything else in Loom depends on
 * `./types.ts` instead.
 *
 * Responsibilities:
 *  - build a pi `Agent` wired to an OpenAI-compatible chat endpoint (`streamFn`)
 *  - translate Loom tools -> pi `AgentTool`
 *  - translate pi `AgentEvent` -> Loom `LoomAgentEvent`
 */
import { Agent, type AgentEvent, type AgentTool } from "#vendor/pi-agent";
import { createModels, createProvider, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
	LoomAgent,
	LoomAgentEvent,
	LoomAgentOptions,
	LoomChatEndpoint,
	LoomTool,
	LoomToolContentPart,
	LoomTranscriptMessage,
} from "./types.ts";

const CHAT_PROVIDER = "loom-chat";

export function chatEndpointReady(chat: LoomChatEndpoint | undefined): chat is LoomChatEndpoint {
	return Boolean(chat?.baseUrl.trim() && chat.model.trim());
}

/** Build a one-model OpenAI-compatible provider from the Chat settings slot. */
function buildModels(chat: LoomChatEndpoint) {
	const baseUrl = chat.baseUrl.trim().replace(/\/+$/, "");
	const modelId = chat.model.trim();
	const apiKey = chat.apiKey?.trim();
	const models = createModels();
	models.setProvider(createProvider({
		id: CHAT_PROVIDER,
		name: "Loom Chat",
		baseUrl,
		auth: {
			apiKey: {
				name: "Chat API key",
				async resolve() {
					return { auth: apiKey ? { apiKey } : {}, source: apiKey ? "settings" : "none" };
				},
			},
		},
		models: [{
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider: CHAT_PROVIDER,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
			},
		}],
		api: openAICompletionsApi(),
	}));
	return models;
}

/** Translate a Loom tool into a pi AgentTool. */
function toPiTool(tool: LoomTool): AgentTool {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: (tool.parameters ?? Type.Object({})) as never,
		execute: async (_toolCallId, params) => {
			const output = await tool.execute(params as never);
			const result = typeof output === "string" ? { content: output } : output;
			return {
				content: toPiContent(result.content),
				details: result.details,
			};
		},
	};
}

class PiAgentAdapter implements LoomAgent {
	private readonly agent: Agent;
	private readonly listeners = new Set<(event: LoomAgentEvent) => void>();

	constructor(options: LoomAgentOptions) {
		if (!chatEndpointReady(options.chat)) {
			throw new Error("Chat is not configured. Set base URL and model in Settings.");
		}
		const models = buildModels(options.chat);
		const model = models.getModel(CHAT_PROVIDER, options.chat.model.trim());
		if (!model) {
			throw new Error(`Unknown model: ${options.chat.model}`);
		}

		this.agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt ?? "",
				model,
				tools: (options.tools ?? []).map(toPiTool),
				messages: (options.initialMessages ?? []) as never,
			},
			streamFn: (m, context, streamOptions) => models.streamSimple(m, context, streamOptions),
		});

		this.agent.subscribe((event) => this.translate(event));
	}

	private emit(event: LoomAgentEvent) {
		for (const listener of this.listeners) listener(event);
	}

	private translate(event: AgentEvent) {
		switch (event.type) {
			case "agent_start":
				this.emit({ type: "agent_start" });
				break;
			case "agent_end":
				this.emit({ type: "agent_end" });
				break;
			case "turn_end": {
				const message = event.message;
				if (message.role === "assistant" && message.errorMessage?.trim()) {
					this.emit({ type: "error", message: message.errorMessage.trim() });
				}
				break;
			}
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					this.emit({ type: "text", delta: inner.delta });
				}
				break;
			}
			case "tool_execution_start":
				this.emit({
					type: "tool_start",
					toolCallId: event.toolCallId,
					name: event.toolName,
					args: event.args,
				});
				break;
			case "tool_execution_end": {
				const text = Array.isArray(event.result?.content)
					? event.result.content
						.filter((part: { type?: string }) => part.type === "text")
						.map((part: { text?: string }) => part.text ?? "")
						.join("\n")
					: String(event.result ?? "");
				this.emit({
					type: "tool_end",
					toolCallId: event.toolCallId,
					name: event.toolName,
					result: { content: text, details: event.result?.details },
					isError: event.isError,
				});
				break;
			}
			default:
				break;
		}
	}

	subscribe(listener: (event: LoomAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(input: string): Promise<void> {
		await this.agent.prompt(input);
		const failed = this.agent.state.errorMessage?.trim();
		if (failed) throw new Error(failed);
	}

	getMessages(): LoomTranscriptMessage[] {
		return this.agent.state.messages as unknown as LoomTranscriptMessage[];
	}

	addTools(tools: LoomTool[]): void {
		if (!tools.length) return;
		this.agent.state.tools = [...this.agent.state.tools, ...tools.map(toPiTool)];
	}

	setSystemPrompt(systemPrompt: string): void {
		this.agent.state.systemPrompt = systemPrompt;
	}
}

function toPiContent(content: string | LoomToolContentPart[]): LoomToolContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content;
}

/** Create a Loom agent backed by the vendored pi engine. */
export function createLoomAgent(options: LoomAgentOptions): LoomAgent {
	return new PiAgentAdapter(options);
}

export { createWorkspaceTools, type WorkspaceTools } from "./pi-tools.ts";
