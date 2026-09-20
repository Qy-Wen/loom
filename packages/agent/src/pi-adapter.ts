/**
 * The ONLY module allowed to import from `#vendor/pi-agent` (and pi-ai for the
 * stream function + model catalog). Everything else in Loom depends on
 * `./types.ts` instead.
 *
 * Responsibilities:
 *  - build a pi `Agent` wired to a pi-ai provider (`streamFn`)
 *  - translate Loom tools -> pi `AgentTool`
 *  - translate pi `AgentEvent` -> Loom `LoomAgentEvent`
 */
import { Agent, type AgentEvent, type AgentTool } from "#vendor/pi-agent";
import { createModels, Type } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { LoomAgent, LoomAgentEvent, LoomAgentOptions, LoomTool } from "./types.ts";

/** Build the pi-ai model runtime with the providers Loom supports. */
function buildModels() {
	const models = createModels();
	// Register providers. deepseekProvider() reads DEEPSEEK_API_KEY from env.
	models.setProvider(deepseekProvider());
	return models;
}

/** Translate a Loom tool into a pi AgentTool. */
function toPiTool(tool: LoomTool): AgentTool {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		// pi expects a typebox schema; callers pass a compatible schema object.
		parameters: (tool.parameters ?? Type.Object({})) as never,
		execute: async (_toolCallId, params) => {
			const output = await tool.execute(params as never);
			return {
				content: [{ type: "text", text: output }],
				details: { output },
			};
		},
	};
}

class PiAgentAdapter implements LoomAgent {
	private readonly agent: Agent;
	private readonly listeners = new Set<(event: LoomAgentEvent) => void>();

	constructor(options: LoomAgentOptions) {
		const models = buildModels();
		const model = models.getModel(options.model.provider, options.model.model);
		if (!model) {
			throw new Error(
				`Unknown model: ${options.model.provider}/${options.model.model}`,
			);
		}

		this.agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt ?? "",
				model,
				tools: (options.tools ?? []).map(toPiTool),
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
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					this.emit({ type: "text", delta: inner.delta });
				}
				// thinking_* deltas intentionally ignored in v1 (see docs/AGENT.md 5.3).
				break;
			}
			case "tool_execution_start":
				this.emit({ type: "tool_start", name: event.toolName, args: event.args });
				break;
			case "tool_execution_end":
				this.emit({ type: "tool_end", name: event.toolName, result: event.result });
				break;
			default:
				// Other pi events (turn_*, message_start/end, tool_execution_update)
				// are not surfaced by Loom's minimal event set yet.
				break;
		}
	}

	subscribe(listener: (event: LoomAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(input: string): Promise<void> {
		await this.agent.prompt(input);
	}
}

/** Create a Loom agent backed by the vendored pi engine. */
export function createLoomAgent(options: LoomAgentOptions): LoomAgent {
	return new PiAgentAdapter(options);
}
