/**
 * Smoke test: run one agent loop against DeepSeek with a single fake tool.
 * Run: pnpm --filter @loom/core try:agent
 *
 * Success = you see agent_start -> (text / tool_start / tool_end) -> agent_end.
 */
import { Type } from "@earendil-works/pi-ai";
import { createLoomAgent } from "../src/index.ts";

async function main() {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error("DEEPSEEK_API_KEY not set (expected via --env-file=../../.env)");
	}

	const agent = createLoomAgent({
		systemPrompt:
			"You are a helpful assistant. When asked to echo something, you MUST call the `echo` tool.",
		chat: {
			baseUrl: "https://api.deepseek.com",
			apiKey: process.env.DEEPSEEK_API_KEY,
			model: "deepseek-v4-flash",
		},
		tools: [
			{
				name: "echo",
				description: "Echo back the given text verbatim.",
				parameters: Type.Object({ text: Type.String() }),
				execute: (args) => {
					const { text } = args as { text: string };
					return `echo: ${text}`;
				},
			},
		],
	});

	agent.subscribe((event) => {
		switch (event.type) {
			case "agent_start":
				console.log("[agent_start]");
				break;
			case "text":
				process.stdout.write(event.delta);
				break;
			case "tool_start":
				console.log(`\n[tool_start] ${event.name}`, event.args);
				break;
			case "tool_end":
				console.log(`[tool_end] ${event.name}`, event.result);
				break;
			case "agent_end":
				console.log("\n[agent_end]");
				break;
		}
	});

	await agent.prompt("Please echo the phrase: Loom is alive.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
