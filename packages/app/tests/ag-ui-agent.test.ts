import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/client";
import type { LoomAgent, LoomAgentEvent, LoomAgentOptions } from "@loom/agent";
import { lastValueFrom, toArray } from "rxjs";
import { LoomAgUiAgent } from "../src/main/ag-ui-agent.ts";

const OPTIONS: LoomAgentOptions = {
	model: { provider: "test", model: "test" },
};

function runInput(threadId = "thread-1", text = "latest question"): RunAgentInput {
	return {
		threadId,
		runId: `run-${threadId}`,
		messages: [
			{ id: "u0", role: "user", content: "older question" },
			{ id: "a0", role: "assistant", content: "older answer" },
			{ id: "u1", role: "user", content: text },
		],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
	} as RunAgentInput;
}

class FakeLoomAgent implements LoomAgent {
	readonly prompts: string[] = [];
	private readonly listeners = new Set<(event: LoomAgentEvent) => void>();
	private readonly events: LoomAgentEvent[];

	constructor(events: LoomAgentEvent[]) {
		this.events = events;
	}

	subscribe(listener: (event: LoomAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(input: string): Promise<void> {
		this.prompts.push(input);
		for (const event of this.events) {
			for (const listener of this.listeners) listener(event);
		}
	}
}

function eventTypes(events: BaseEvent[]): string[] {
	return events.map((event) => event.type);
}

describe("LoomAgUiAgent", () => {
	it("maps a streamed Loom response to a complete AG-UI run", async () => {
		const fake = new FakeLoomAgent([
			{ type: "agent_start" },
			{ type: "text", delta: "hello " },
			{ type: "text", delta: "world" },
			{ type: "agent_end" },
		]);
		const adapter = new LoomAgUiAgent(OPTIONS, () => fake);

		const events = await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		assert.deepEqual(eventTypes(events), [
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		assert.deepEqual(fake.prompts, ["latest question"]);
		assert.equal((events[2] as unknown as { delta: string }).delta, "hello ");
		assert.equal((events[3] as unknown as { delta: string }).delta, "world");
	});

	it("maps tool calls and reuses one Loom conversation per thread", async () => {
		let factoryCalls = 0;
		const fake = new FakeLoomAgent([
			{ type: "agent_start" },
			{ type: "tool_start", name: "search_assets", args: { query: "sunset" } },
			{ type: "tool_end", name: "search_assets", result: [] },
			{ type: "agent_end" },
		]);
		const adapter = new LoomAgUiAgent(OPTIONS, () => {
			factoryCalls += 1;
			return fake;
		});

		const first = await lastValueFrom(adapter.run(runInput("same-thread", "one")).pipe(toArray()));
		await lastValueFrom(adapter.run(runInput("same-thread", "two")).pipe(toArray()));

		assert.equal(factoryCalls, 1);
		assert.deepEqual(fake.prompts, ["one", "two"]);
		assert.deepEqual(eventTypes(first), [
			EventType.RUN_STARTED,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.RUN_FINISHED,
		]);
		assert.equal((first[2] as unknown as { delta: string }).delta, '{"query":"sunset"}');
	});
});
