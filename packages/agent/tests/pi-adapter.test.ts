import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { chatEndpointReady, createLoomAgent } from "../src/pi-adapter.ts";
import type { LoomAgentEvent } from "../src/types.ts";

describe("createLoomAgent", () => {
	it("rejects an incomplete Chat slot before a run starts", () => {
		assert.throws(
			() => createLoomAgent({}),
			/Chat is not configured/,
		);
		assert.throws(
			() => createLoomAgent({ chat: { baseUrl: "https://example.com", model: "" } }),
			/Chat is not configured/,
		);
	});

	it("accepts a Chat slot and builds an agent", () => {
		const agent = createLoomAgent({
			chat: { baseUrl: "https://example.com/v1", model: "demo" },
		});
		assert.equal(typeof agent.prompt, "function");
		assert.deepEqual(agent.getMessages(), []);
	});
});

describe("abort", () => {
	it("ends a hanging Chat stream without an error event and keeps the turn", async () => {
		let requests = 0;
		const arrivals = [deferred<void>(), deferred<void>()];
		const server = createServer((request, response) => {
			const index = requests;
			requests += 1;
			request.on("aborted", () => response.end());
			arrivals[index]?.resolve();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as AddressInfo).port;
		const agent = createLoomAgent({
			chat: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "demo" },
		});
		const events: LoomAgentEvent[] = [];
		agent.subscribe((event) => events.push(event));

		try {
			const first = agent.prompt("one");
			await arrivals[0]?.promise;
			agent.abort();
			const second = agent.prompt("two");
			await first;
			await arrivals[1]?.promise;
			agent.abort();
			await second;
			assert.equal(events.some((event) => event.type === "error"), false);
			const assistants = agent.getMessages().filter((message) => message.role === "assistant");
			assert.ok(assistants.length >= 1);
			assert.ok(assistants.every((message) => message.stopReason === "aborted"));
			assert.equal(JSON.stringify(assistants).includes("pressed Stop"), false);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("records a user Stop in the turn the next prompt will see", async () => {
		const arrived = deferred<void>();
		const server = createServer((request, response) => {
			request.on("aborted", () => response.end());
			arrived.resolve();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as AddressInfo).port;
		const agent = createLoomAgent({
			chat: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "demo" },
		});

		try {
			const pending = agent.prompt("stop this");
			await arrived.promise;
			agent.abort("user");
			await pending;
			const assistants = agent.getMessages().filter((message) => message.role === "assistant");
			assert.equal(assistants.at(-1)?.stopReason, "aborted");
			const text = JSON.stringify(assistants.at(-1)?.content);
			assert.match(text, /The user pressed Stop/);
			assert.match(text, /not because of an error/);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("chatEndpointReady", () => {
	it("requires a trimmed base URL and model", () => {
		assert.equal(chatEndpointReady(undefined), false);
		assert.equal(chatEndpointReady({ baseUrl: "  ", model: "x" }), false);
		assert.equal(chatEndpointReady({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama" }), true);
	});
});
