import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/client";
import {
	parseUserAttachments,
	type LoomAgent,
	type LoomAgentEvent,
	type LoomAgentOptions,
	type LoomPromptOptions,
	type LoomTool,
	type LoomTranscriptMessage,
	type LoomUserAttachment,
	type UiSelectionFields,
} from "@loom/agent";
import { DEFAULT_SESSION_TITLE } from "@loom/core";
import { lastValueFrom, toArray } from "rxjs";
import { type AgentSessionStore, LoomAgUiAgent } from "../src/main/ag-ui-agent.ts";

const OPTIONS: LoomAgentOptions = {
	chat: { baseUrl: "http://127.0.0.1:9", model: "test" },
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
	readonly promptAttachments: Array<LoomUserAttachment[] | undefined> = [];
	readonly addedTools: LoomTool[] = [];
	systemPrompt = "";
	private readonly listeners = new Set<(event: LoomAgentEvent) => void>();
	private readonly events: LoomAgentEvent[];
	private readonly failure?: string;
	aborted = false;

	constructor(events: LoomAgentEvent[], failure?: string) {
		this.events = events;
		this.failure = failure;
	}

	subscribe(listener: (event: LoomAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(input: string, options?: LoomPromptOptions): Promise<void> {
		this.prompts.push(input);
		this.promptAttachments.push(options?.attachments);
		for (const event of this.events) {
			for (const listener of this.listeners) listener(event);
		}
		if (this.failure) throw new Error(this.failure);
	}

	abort(): void {
		this.aborted = true;
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

	it("maps thinking deltas to reasoning messages and then the reply", async () => {
		const adapter = new LoomAgUiAgent(OPTIONS, () => new FakeLoomAgent([
			{ type: "agent_start" },
			{ type: "thinking_start" },
			{ type: "thinking_delta", delta: "because " },
			{ type: "thinking_delta", delta: "so" },
			{ type: "thinking_end" },
			{ type: "text", delta: "answer" },
			{ type: "agent_end" },
		]));
		const events = await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		assert.deepEqual(eventTypes(events), [
			EventType.RUN_STARTED,
			EventType.REASONING_START,
			EventType.REASONING_MESSAGE_START,
			EventType.REASONING_MESSAGE_CONTENT,
			EventType.REASONING_MESSAGE_CONTENT,
			EventType.REASONING_MESSAGE_END,
			EventType.REASONING_END,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		const deltas = events
			.filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
			.map((event) => (event as unknown as { delta: string }).delta);
		assert.deepEqual(deltas, ["because ", "so"]);
		assert.equal(JSON.stringify(events).includes("thoughtSignature"), false);
	});

	it("writes a Chat failure into the transcript instead of going silent", async () => {
		const adapter = new LoomAgUiAgent(OPTIONS, () => new FakeLoomAgent([
			{ type: "agent_start" },
			{ type: "error", message: "401 Unauthorized" },
			{ type: "agent_end" },
		], "401 Unauthorized"));
		const events = await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), true);
		assert.equal(events.some((event) => event.type === EventType.RUN_FINISHED), false);
		const start = events.find((event) => event.type === EventType.TEXT_MESSAGE_START);
		assert.match(String((start as unknown as { messageId: string }).messageId), /^loom-error-/);
		const text = events.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT);
		assert.match(String((text as unknown as { delta: string }).delta), /API key was rejected/);
	});

	it("surfaces a missing Chat slot before the run starts", async () => {
		const adapter = new LoomAgUiAgent(OPTIONS, () => {
			throw new Error("Chat is not configured. Set base URL and model in Settings.");
		});
		const events = await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		assert.equal(events[0]?.type, EventType.RUN_STARTED);
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), true);
		const text = events.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT);
		assert.match(String((text as unknown as { delta: string }).delta), /Set a base URL and model/);
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

	it("starts a new assistant message after tools so text and results stay in order", async () => {
		const fake = new FakeLoomAgent([
			{ type: "agent_start" },
			{ type: "text", delta: "looking" },
			{ type: "tool_start", toolCallId: "call-1", name: "search_assets", args: {} },
			{
				type: "tool_end",
				toolCallId: "call-1",
				name: "search_assets",
				result: { content: "found" },
				isError: false,
			},
			{ type: "text", delta: "done" },
			{ type: "agent_end" },
		]);
		const adapter = new LoomAgUiAgent(OPTIONS, () => fake);
		const events = await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		const starts = events
			.filter((event) => event.type === EventType.TEXT_MESSAGE_START)
			.map((event) => event as unknown as { messageId: string });
		assert.equal(starts.length, 2);
		assert.notEqual(starts[0]?.messageId, starts[1]?.messageId);
		const toolStart = events.find((event) => event.type === EventType.TOOL_CALL_START) as unknown as {
			parentMessageId?: string;
		};
		assert.equal(toolStart.parentMessageId, starts[0]?.messageId);
		assert.deepEqual(eventTypes(events), [
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_RESULT,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
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
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_RESULT,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		assert.equal((first[3] as unknown as { toolCallId: string }).toolCallId, "call-1");
		assert.equal((first[4] as unknown as { delta: string }).delta, '{"query":"sunset"}');
		assert.equal((first[6] as unknown as { content: string }).content, "found");
		assert.deepEqual(
			(first[7] as unknown as { value: { details: unknown } }).value.details,
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

	it("applies a new Chat slot and drops live sessions", async () => {
		const seen: LoomAgentOptions[] = [];
		const adapter = new LoomAgUiAgent(OPTIONS, (options) => {
			seen.push(options);
			return new FakeLoomAgent([{ type: "agent_end" }]);
		});
		await lastValueFrom(adapter.run(runInput("t1", "hi")).pipe(toArray()));
		adapter.setChat({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama" });
		await lastValueFrom(adapter.run(runInput("t1", "again")).pipe(toArray()));
		assert.equal(seen.length, 2);
		assert.equal(seen[1]?.chat?.model, "llama");
		assert.equal(seen[1]?.chat?.baseUrl, "http://127.0.0.1:11434/v1");
	});

	it("attaches the UI selection once, then skips the same asset", async () => {
		const selection = {
			assetId: "asset-1",
			path: "clips/hero.mp4",
			assetType: "video" as const,
		};
		let current: UiSelectionFields = selection;
		const created: ScriptedAgent[] = [];
		const adapter = new LoomAgUiAgent(OPTIONS, (options) => {
			const agent = new ScriptedAgent(
				[{ type: "agent_start" }, { type: "text", delta: "ok" }, { type: "agent_end" }],
				options.initialMessages ?? [],
			);
			created.push(agent);
			return agent;
		}, undefined, () => current);

		await lastValueFrom(adapter.run(runInput("sel-1", "把这个处理一下")).pipe(toArray()));
		assert.deepEqual(created[0]?.promptAttachments[0], [{ type: "ui_selection", ...selection }]);
		assert.equal(parseUserAttachments(created[0]?.messages[0]?.attachments)[0]?.type, "ui_selection");

		await lastValueFrom(adapter.run(runInput("sel-1", "再裁短一点")).pipe(toArray()));
		assert.equal(created[0]?.promptAttachments[1], undefined);

		current = { assetId: "asset-2", path: "notes/brief.md", assetType: "text" };
		await lastValueFrom(adapter.run(runInput("sel-1", "这篇也看下")).pipe(toArray()));
		assert.deepEqual(created[0]?.promptAttachments[2], [{
			type: "ui_selection",
			assetId: "asset-2",
			path: "notes/brief.md",
			assetType: "text",
		}]);
	});

	it("records Chat usage from new assistant messages", async () => {
		const recorded: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }> = [];
		class UsageAgent extends ScriptedAgent {
			override async prompt(input: string, options?: LoomPromptOptions): Promise<void> {
				this.messages.push({ role: "user", content: input });
				this.messages.push({
					role: "assistant",
					content: "ok",
					usage: { input: 100, output: 20, cacheRead: 768, cacheWrite: 0 },
				});
				await FakeLoomAgent.prototype.prompt.call(this, input, options);
			}
		}
		const adapter = new LoomAgUiAgent(
			OPTIONS,
			() => new UsageAgent(
				[{ type: "agent_start" }, { type: "text", delta: "ok" }, { type: "agent_end" }],
				[],
			),
			undefined,
			undefined,
			(usage) => recorded.push(usage),
		);
		await lastValueFrom(adapter.run(runInput("usage-1", "hi")).pipe(toArray()));
		assert.deepEqual(recorded, [{ input: 100, output: 20, cacheRead: 768, cacheWrite: 0 }]);
	});

	it("replaces tools and drops live sessions", async () => {
		const seen: LoomAgentOptions[] = [];
		const adapter = new LoomAgUiAgent({ ...OPTIONS, tools: [] }, (options) => {
			seen.push(options);
			return new FakeLoomAgent([{ type: "agent_end" }]);
		});
		await lastValueFrom(adapter.run(runInput("t1", "hi")).pipe(toArray()));
		const extra: LoomTool = { name: "comfy__x", description: "x", parameters: {}, execute: async () => "ok" };
		adapter.setTools([extra]);
		await lastValueFrom(adapter.run(runInput("t1", "again")).pipe(toArray()));
		assert.equal(seen.length, 2);
		assert.deepEqual(seen[1]?.tools?.map((tool) => tool.name), ["comfy__x"]);
	});

	it("abortRun stops the in-flight prompt without a run error", async () => {
		const agent = new HangingAgent();
		const store = new MemorySessionStore();
		store.records.set("thread-stop", { title: "kept", messages: [] });
		const adapter = new LoomAgUiAgent(OPTIONS, () => agent, store);
		adapter.threadId = "thread-stop";
		const events: BaseEvent[] = [];
		const pending = adapter.runAgent(runInput("thread-stop", "stop me"), {
			onEvent: ({ event }) => {
				events.push(event);
			},
		});
		await agent.started;
		adapter.abortRun();
		await Promise.race([
			pending,
			new Promise((_, reject) => {
				setTimeout(() => reject(new Error("abortRun did not finish the run")), 1000);
			}),
		]);
		await agent.settled;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if ((store.records.get("thread-stop")?.messages.length ?? 0) > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		assert.equal(agent.aborted, true);
		assert.equal(agent.abortReason, "user");
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), false);
		assert.equal(store.records.get("thread-stop")?.messages.at(-1)?.stopReason, "aborted");
	});

	it("aborts on unsubscribe and still appends the turn", async () => {
		const agent = new HangingAgent();
		const store = new MemorySessionStore();
		store.records.set("thread-stop", { title: "kept", messages: [] });
		const adapter = new LoomAgUiAgent(OPTIONS, () => agent, store);
		const events: BaseEvent[] = [];
		const subscription = adapter.run(runInput("thread-stop", "stop me")).subscribe({
			next: (event) => events.push(event),
		});
		await agent.started;
		subscription.unsubscribe();
		await agent.settled;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if ((store.records.get("thread-stop")?.messages.length ?? 0) > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		assert.equal(agent.aborted, true);
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), false);
		assert.equal(store.records.get("thread-stop")?.messages.at(-1)?.stopReason, "aborted");
	});

	it("aborts the in-flight run before the next prompt on the same thread", async () => {
		const agent = new HangingAgent();
		const adapter = new LoomAgUiAgent(OPTIONS, () => agent);
		const first = adapter.run(runInput("same", "one")).subscribe({ next() {} });
		await agent.started;
		const events = await lastValueFrom(adapter.run(runInput("same", "two")).pipe(toArray()));
		first.unsubscribe();
		assert.equal(agent.aborted, true);
		assert.deepEqual(agent.prompts, ["one", "two"]);
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), false);
		assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
	});

	it("does not prompt when unsubscribed before the session loads", async () => {
		const store = new MemorySessionStore();
		store.records.set("thread-early", { title: DEFAULT_SESSION_TITLE, messages: [] });
		let releaseOpen = (): void => undefined;
		const opened = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const openSession = store.openSession.bind(store);
		store.openSession = async (id) => {
			await opened;
			return openSession(id);
		};
		let agent: HangingAgent | undefined;
		const adapter = new LoomAgUiAgent(OPTIONS, () => {
			agent = new HangingAgent();
			return agent;
		}, store);
		const subscription = adapter.run(runInput("thread-early", "nope")).subscribe({ next() {} });
		subscription.unsubscribe();
		releaseOpen();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(agent?.prompts.length, 0);
		assert.equal(agent?.aborted, true);
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

class HangingAgent implements LoomAgent {
	readonly prompts: string[] = [];
	aborted = false;
	abortReason: "user" | undefined;
	messages: LoomTranscriptMessage[] = [];
	readonly started: Promise<void>;
	readonly settled: Promise<void>;
	private readonly listeners = new Set<(event: LoomAgentEvent) => void>();
	private release: (() => void) | undefined;
	private markStarted: () => void = () => undefined;
	private markSettled: () => void = () => undefined;

	constructor() {
		this.started = new Promise((resolve) => {
			this.markStarted = resolve;
		});
		this.settled = new Promise((resolve) => {
			this.markSettled = resolve;
		});
	}

	subscribe(listener: (event: LoomAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abort(reason?: "user"): void {
		this.aborted = true;
		if (reason) this.abortReason = reason;
		this.release?.();
		this.release = undefined;
	}

	async prompt(input: string): Promise<void> {
		this.prompts.push(input);
		if (this.prompts.length > 1) {
			for (const listener of this.listeners) {
				listener({ type: "agent_start" });
				listener({ type: "text", delta: "ok" });
				listener({ type: "agent_end" });
			}
			this.messages.push({ role: "user", content: input });
			this.messages.push({ role: "assistant", content: "ok" });
			return;
		}
		for (const listener of this.listeners) listener({ type: "agent_start" });
		this.markStarted();
		await new Promise<void>((resolve) => {
			if (this.aborted) resolve();
			else this.release = resolve;
		});
		this.messages.push({ role: "user", content: input });
		this.messages.push({ role: "assistant", content: "", stopReason: "aborted" });
		this.markSettled();
	}

	getMessages(): LoomTranscriptMessage[] {
		return this.messages;
	}

	addTools(): void {}

	setSystemPrompt(): void {}
}

class ScriptedAgent extends FakeLoomAgent {
	messages: LoomTranscriptMessage[];

	constructor(events: LoomAgentEvent[], initial: LoomTranscriptMessage[]) {
		super(events);
		this.messages = [...initial];
	}

	override async prompt(input: string, options?: LoomPromptOptions): Promise<void> {
		this.messages.push({
			role: "user",
			content: input,
			...(options?.attachments?.length ? { attachments: options.attachments } : {}),
		});
		this.messages.push({ role: "assistant", content: "ok" });
		await super.prompt(input, options);
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
