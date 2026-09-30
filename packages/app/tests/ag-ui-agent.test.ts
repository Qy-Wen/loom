import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import {
	type HarnessSessionManager,
	type LoomAgentEvent,
	type LoomUserAttachment,
	type UiSelectionFields,
} from "@loom/agent";
import { DEFAULT_SESSION_TITLE } from "@loom/agent";
import { lastValueFrom, toArray } from "rxjs";
import { LoomAgUiAgent } from "../src/main/ag-ui-agent.ts";

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

class FakeManager {
	readonly records = new Map<string, { title: string; messages: Array<{ role: string; content: string; attachments?: LoomUserAttachment[]; stopReason?: string }> }>();
	readonly prompts: Array<{ id: string; text: string; attachments?: LoomUserAttachment[] }> = [];
	readonly aborts: Array<{ id: string; reason?: "user" }> = [];
	readonly events: LoomAgentEvent[];
	failure?: string;
	onPrompt?: (id: string, text: string) => Promise<void>;

	constructor(events: LoomAgentEvent[] = [
		{ type: "agent_start" },
		{ type: "text", delta: "ok" },
		{ type: "agent_end" },
	]) {
		this.events = events;
		this.records.set("thread-1", { title: DEFAULT_SESSION_TITLE, messages: [] });
	}

	asManager(): HarnessSessionManager {
		return this as unknown as HarnessSessionManager;
	}

	async openSession(id: string) {
		const record = this.records.get(id);
		if (!record) throw new Error(`Session not found: ${id}`);
		return record;
	}

	async setSessionName(id: string, title: string): Promise<void> {
		const record = await this.openSession(id);
		record.title = title;
	}

	async prompt(id: string, text: string, options?: { attachments?: LoomUserAttachment[]; onEvent?: (event: LoomAgentEvent) => void }): Promise<void> {
		const record = await this.openSession(id);
		this.prompts.push({ id, text, attachments: options?.attachments });
		if (this.onPrompt) await this.onPrompt(id, text);
		for (const event of this.events) options?.onEvent?.(event);
		if (this.failure) throw new Error(this.failure);
		record.messages.push({ role: "user", content: text, attachments: options?.attachments });
		record.messages.push({ role: "assistant", content: "ok" });
	}

	async abort(id: string, reason?: "user"): Promise<void> {
		this.aborts.push({ id, reason });
	}
}

function eventTypes(events: BaseEvent[]): string[] {
	return events.map((event) => event.type);
}

describe("LoomAgUiAgent", () => {
	it("maps a streamed Harness response to a complete AG-UI run", async () => {
		const manager = new FakeManager([
			{ type: "agent_start" },
			{ type: "text", delta: "hello " },
			{ type: "text", delta: "world" },
			{ type: "agent_end" },
		]);
		const events = await lastValueFrom(new LoomAgUiAgent(manager.asManager()).run(runInput()).pipe(toArray()));
		assert.deepEqual(eventTypes(events), [
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		assert.deepEqual(manager.prompts, [{ id: "thread-1", text: "latest question", attachments: undefined }]);
		assert.equal((events[2] as unknown as { delta: string }).delta, "hello ");
		assert.equal(manager.records.get("thread-1")?.title, "latest question");
	});

	it("maps thinking deltas to reasoning messages and then the reply", async () => {
		const manager = new FakeManager([
			{ type: "agent_start" },
			{ type: "thinking_start" },
			{ type: "thinking_delta", delta: "because " },
			{ type: "thinking_delta", delta: "so" },
			{ type: "thinking_end" },
			{ type: "text", delta: "answer" },
			{ type: "agent_end" },
		]);
		const events = await lastValueFrom(new LoomAgUiAgent(manager.asManager()).run(runInput()).pipe(toArray()));
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
		assert.deepEqual(events.filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT).map((event) => (event as unknown as { delta: string }).delta), ["because ", "so"]);
	});

	it("writes a Chat failure into the transcript instead of going silent", async () => {
		const manager = new FakeManager([
			{ type: "agent_start" },
			{ type: "error", message: "401 Unauthorized" },
			{ type: "agent_end" },
		]);
		manager.failure = "401 Unauthorized";
		const events = await lastValueFrom(new LoomAgUiAgent(manager.asManager()).run(runInput()).pipe(toArray()));
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), true);
		assert.equal(events.some((event) => event.type === EventType.RUN_FINISHED), false);
		const start = events.find((event) => event.type === EventType.TEXT_MESSAGE_START);
		assert.match(String((start as unknown as { messageId: string }).messageId), /^loom-error-/);
		const text = events.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT);
		assert.match(String((text as unknown as { delta: string }).delta), /API key was rejected/);
	});

	it("surfaces an unconfigured Chat slot", async () => {
		const manager = new FakeManager([]);
		manager.failure = "Chat is not configured. Set base URL and model in Settings.";
		const events = await lastValueFrom(new LoomAgUiAgent(manager.asManager()).run(runInput()).pipe(toArray()));
		assert.equal(events[0]?.type, EventType.RUN_STARTED);
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), true);
		const texts = events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT);
		assert.equal(texts.some((event) => /Set a base URL and model/.test(String((event as unknown as { delta: string }).delta))), true);
	});

	it("rejects unknown threads rather than creating a transient agent", async () => {
		const manager = new FakeManager();
		const events = await lastValueFrom(new LoomAgUiAgent(manager.asManager()).run(runInput("unknown")).pipe(toArray()));
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), true);
		assert.deepEqual(manager.prompts, []);
	});

	it("maps tool calls with stable IDs, ordered text and structured results", async () => {
		const manager = new FakeManager([
			{ type: "agent_start" },
			{ type: "text", delta: "looking" },
			{ type: "tool_start", toolCallId: "call-1", name: "search_assets", args: { query: "sunset" } },
			{ type: "tool_end", toolCallId: "call-1", name: "search_assets", result: { content: "found", details: { kind: "asset_list", assets: [] } }, isError: false },
			{ type: "text", delta: "done" },
			{ type: "agent_end" },
		]);
		const adapter = new LoomAgUiAgent(manager.asManager());
		const events = await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		assert.deepEqual(eventTypes(events), [
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_RESULT,
			EventType.CUSTOM,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		const starts = events.filter((event) => event.type === EventType.TEXT_MESSAGE_START) as unknown as Array<{ messageId: string }>;
		assert.notEqual(starts[0]?.messageId, starts[1]?.messageId);
		assert.equal((events[4] as unknown as { parentMessageId: string }).parentMessageId, starts[0]?.messageId);
		assert.equal((events[5] as unknown as { delta: string }).delta, '{"query":"sunset"}');
		assert.deepEqual((events[8] as unknown as { value: { details: unknown } }).value.details, { kind: "asset_list", assets: [] });
		const again = await lastValueFrom(adapter.run(runInput("thread-1", "follow up")).pipe(toArray()));
		assert.equal(again.at(-1)?.type, EventType.RUN_FINISHED);
		assert.deepEqual(manager.prompts.map(({ text }) => text), ["latest question", "follow up"]);
	});

	it("passes the UI selection once, then skips the same asset", async () => {
		const selection = { assetId: "asset-1", path: "clips/hero.mp4", assetType: "video" as const };
		let current: UiSelectionFields = selection;
		const manager = new FakeManager();
		const adapter = new LoomAgUiAgent(manager.asManager(), () => current);
		await lastValueFrom(adapter.run(runInput()).pipe(toArray()));
		assert.deepEqual(manager.prompts[0]?.attachments, [{ type: "ui_selection", ...selection }]);
		await lastValueFrom(adapter.run(runInput("thread-1", "follow up")).pipe(toArray()));
		assert.equal(manager.prompts[1]?.attachments, undefined);
		current = { assetId: "asset-2", path: "notes/brief.md", assetType: "text" };
		await lastValueFrom(adapter.run(runInput("thread-1", "other")).pipe(toArray()));
		assert.deepEqual(manager.prompts[2]?.attachments, [{ type: "ui_selection", ...current }]);
	});

	it("abortRun reaches the manager and unsubscribes without a run error", async () => {
		const manager = new FakeManager();
		let release = (): void => undefined;
		let started = (): void => undefined;
		const began = new Promise<void>((resolve) => { started = resolve; });
		manager.onPrompt = async () => {
			started();
			await new Promise<void>((resolve) => { release = resolve; });
		};
		const abort = manager.abort.bind(manager);
		manager.abort = async (id, reason) => { await abort(id, reason); release(); };
		const adapter = new LoomAgUiAgent(manager.asManager());
		adapter.threadId = "thread-1";
		const events: BaseEvent[] = [];
		const pending = adapter.runAgent(runInput(), { onEvent: ({ event }) => { events.push(event); } });
		await began;
		adapter.abortRun();
		await pending;
		assert.equal(manager.aborts.some((entry) => entry.reason === "user"), true);
		assert.equal(events.some((event) => event.type === EventType.RUN_ERROR), false);
	});

	it("does not prompt when unsubscribed before a session opens", async () => {
		const manager = new FakeManager();
		let release = (): void => undefined;
		const opened = new Promise<void>((resolve) => { release = resolve; });
		const openSession = manager.openSession.bind(manager);
		manager.openSession = async (id) => {
			await opened;
			return openSession(id);
		};
		const subscription = new LoomAgUiAgent(manager.asManager()).run(runInput()).subscribe({ next() {} });
		subscription.unsubscribe();
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(manager.prompts, []);
		assert.deepEqual(manager.aborts, []);
	});

	it("retries abort if Stop happens before the manager emits agent_start", async () => {
		const manager = new FakeManager();
		let release = (): void => undefined;
		let started = (): void => undefined;
		const began = new Promise<void>((resolve) => { started = resolve; });
		manager.onPrompt = async () => {
			started();
			await new Promise<void>((resolve) => { release = resolve; });
		};
		const subscription = new LoomAgUiAgent(manager.asManager()).run(runInput()).subscribe({ next() {} });
		await began;
		subscription.unsubscribe();
		assert.equal(manager.aborts.length, 1);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(manager.aborts.length, 2);
	});

	it("shares manager and in-flight prompts across CopilotKit clones", async () => {
		const manager = new FakeManager();
		let release = (): void => undefined;
		let started = (): void => undefined;
		const began = new Promise<void>((resolve) => { started = resolve; });
		manager.onPrompt = async (_id, text) => {
			if (text !== "one") return;
			started();
			await new Promise<void>((resolve) => { release = resolve; });
		};
		const abort = manager.abort.bind(manager);
		manager.abort = async (id, reason) => { await abort(id, reason); release(); };
		const adapter = new LoomAgUiAgent(manager.asManager());
		const first = adapter.run(runInput("thread-1", "one")).subscribe({ next() {} });
		await began;
		const clone = adapter.clone();
		const events = await lastValueFrom(clone.run(runInput("thread-1", "two")).pipe(toArray()));
		first.unsubscribe();
		assert.deepEqual(manager.prompts.map(({ text }) => text), ["one", "two"]);
		assert.equal(manager.aborts.length > 0, true);
		assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
	});

	it("aborts a previous prompt before running the next on the same thread", async () => {
		const manager = new FakeManager();
		let release = (): void => undefined;
		let started = (): void => undefined;
		const began = new Promise<void>((resolve) => { started = resolve; });
		manager.onPrompt = async (_id, text) => {
			if (text !== "one") return;
			started();
			await new Promise<void>((resolve) => { release = resolve; });
		};
		const abort = manager.abort.bind(manager);
		manager.abort = async (id, reason) => { await abort(id, reason); release(); };
		const adapter = new LoomAgUiAgent(manager.asManager());
		const first = adapter.run(runInput("thread-1", "one")).subscribe({ next() {} });
		await began;
		const events = await lastValueFrom(adapter.run(runInput("thread-1", "two")).pipe(toArray()));
		first.unsubscribe();
		assert.deepEqual(manager.prompts.map(({ text }) => text), ["one", "two"]);
		assert.equal(manager.aborts.length > 0, true);
		assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
	});
});
