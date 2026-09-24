import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/client";
import type { LoomAgent, LoomAgentEvent, LoomAgentOptions, LoomTool, LoomTranscriptMessage } from "@loom/agent";
import { DEFAULT_SESSION_TITLE } from "@loom/core";
import { lastValueFrom, toArray } from "rxjs";
import { type AgentSessionStore, LoomAgUiAgent } from "../src/main/ag-ui-agent.ts";

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
	readonly addedTools: LoomTool[] = [];
	systemPrompt = "";
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

	getMessages(): LoomTranscriptMessage[] {
		return [];
	}

	addTools(tools: LoomTool[]): void {
		this.addedTools.push(...tools);
	}

	setSystemPrompt(systemPrompt: string): void {
		this.systemPrompt = systemPrompt;
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

	it("keeps repeated same-name tool calls separated by their stable IDs", async () => {
		const fake = new FakeLoomAgent([
			{ type: "agent_start" },
			{ type: "tool_start", toolCallId: "call-a", name: "search_assets", args: { query: "a" } },
			{ type: "tool_start", toolCallId: "call-b", name: "search_assets", args: { query: "b" } },
			{
				type: "tool_end",
				toolCallId: "call-b",
				name: "search_assets",
				result: { content: "b" },
				isError: false,
			},
			{
				type: "tool_end",
				toolCallId: "call-a",
				name: "search_assets",
				result: { content: "a" },
				isError: false,
			},
			{ type: "agent_end" },
		]);
		const adapter = new LoomAgUiAgent(OPTIONS, () => fake);
		const events = await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		const ids = events
			.filter((event) => event.type === EventType.TOOL_CALL_START || event.type === EventType.TOOL_CALL_END)
			.map((event) => (event as unknown as { toolCallId: string }).toolCallId);
		assert.deepEqual(ids, ["call-a", "call-b", "call-b", "call-a"]);
	});

	it("maps tool calls and reuses one Loom conversation per thread", async () => {
		let factoryCalls = 0;
		const fake = new FakeLoomAgent([
			{ type: "agent_start" },
			{ type: "tool_start", toolCallId: "call-1", name: "search_assets", args: { query: "sunset" } },
			{
				type: "tool_end",
				toolCallId: "call-1",
				name: "search_assets",
				result: { content: "found", details: { kind: "asset_list", assets: [] } },
				isError: false,
			},
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
			EventType.TOOL_CALL_RESULT,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		assert.equal((first[1] as unknown as { toolCallId: string }).toolCallId, "call-1");
		assert.equal((first[2] as unknown as { delta: string }).delta, '{"query":"sunset"}');
		assert.equal((first[4] as unknown as { content: string }).content, "found");
		assert.deepEqual(
			(first[5] as unknown as { value: { details: unknown } }).value.details,
			{ kind: "asset_list", assets: [] },
		);
	});

	it("restores transcript messages and appends new ones after a run", async () => {
		const store = new MemorySessionStore();
		store.records.set("thread-restore", {
			title: DEFAULT_SESSION_TITLE,
			messages: [{ role: "user", content: "older question" }],
		});
		const created: ScriptedAgent[] = [];
		const adapter = new LoomAgUiAgent(OPTIONS, (options) => {
			const agent = new ScriptedAgent(
				[{ type: "agent_start" }, { type: "text", delta: "ok" }, { type: "agent_end" }],
				options.initialMessages ?? [],
			);
			created.push(agent);
			return agent;
		}, store);

		await lastValueFrom(adapter.run(runInput("thread-restore", "follow up")).pipe(toArray()));

		assert.equal(created.length, 1);
		assert.deepEqual(created[0]?.messages[0], { role: "user", content: "older question" });
		const saved = store.records.get("thread-restore");
		assert.equal(saved?.title, "follow up");
		assert.deepEqual(saved?.messages.at(-1), { role: "assistant", content: "ok" });
	});

	it("adds tools to live sessions and later-created ones", async () => {
		const created: FakeLoomAgent[] = [];
		const seen: LoomAgentOptions[] = [];
		const adapter = new LoomAgUiAgent({ ...OPTIONS, tools: [] }, (options) => {
			seen.push(options);
			const fake = new FakeLoomAgent([
				{ type: "agent_start" },
				{ type: "text", delta: "ok" },
				{ type: "agent_end" },
			]);
			created.push(fake);
			return fake;
		});
		await lastValueFrom(adapter.run(runInput("t1")).pipe(toArray()));
		const extra: LoomTool = { name: "comfy__x", description: "x", parameters: {}, execute: async () => "ok" };
		adapter.addTools([extra]);
		assert.deepEqual(created[0]?.addedTools.map((tool) => tool.name), ["comfy__x"]);
		await lastValueFrom(adapter.run(runInput("t2")).pipe(toArray()));
		assert.equal(seen[1]?.tools?.[0]?.name, "comfy__x");
	});

	it("sets the working directory on live sessions and later-created ones", async () => {
		const created: FakeLoomAgent[] = [];
		const seen: LoomAgentOptions[] = [];
		const adapter = new LoomAgUiAgent(OPTIONS, (options) => {
			seen.push(options);
			const fake = new FakeLoomAgent([{ type: "agent_end" }]);
			created.push(fake);
			return fake;
		});
		await lastValueFrom(adapter.run(runInput("t1", "hi")).pipe(toArray()));
		adapter.setSystemPrompt("library D:\\assets");
		assert.equal(created[0]?.systemPrompt, "library D:\\assets");
		await lastValueFrom(adapter.run(runInput("t2", "hi")).pipe(toArray()));
		assert.equal(seen[1]?.systemPrompt, "library D:\\assets");
	});
});

class ScriptedAgent extends FakeLoomAgent {
	messages: LoomTranscriptMessage[];

	constructor(events: LoomAgentEvent[], initial: LoomTranscriptMessage[]) {
		super(events);
		this.messages = [...initial];
	}

	override async prompt(input: string): Promise<void> {
		this.messages.push({ role: "user", content: input });
		this.messages.push({ role: "assistant", content: "ok" });
		await super.prompt(input);
	}

	override getMessages() {
		return this.messages;
	}
}

class MemorySessionStore implements AgentSessionStore {
	readonly records = new Map<string, { title: string; messages: LoomTranscriptMessage[] }>();

	async openSession(id: string) {
		const record = this.records.get(id);
		if (!record) throw new Error(`missing ${id}`);
		return record;
	}

	async appendSessionMessages(id: string, messages: LoomTranscriptMessage[]) {
		const record = this.records.get(id);
		if (!record) throw new Error(`missing ${id}`);
		record.messages.push(...messages);
	}

	async setSessionName(id: string, title: string) {
		const record = this.records.get(id);
		if (!record) throw new Error(`missing ${id}`);
		record.title = title;
	}

	resetSessionHandles() {
		return undefined;
	}
}
