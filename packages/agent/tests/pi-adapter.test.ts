import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatEndpointReady, createLoomAgent } from "../src/pi-adapter.ts";

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

describe("chatEndpointReady", () => {
	it("requires a trimmed base URL and model", () => {
		assert.equal(chatEndpointReady(undefined), false);
		assert.equal(chatEndpointReady({ baseUrl: "  ", model: "x" }), false);
		assert.equal(chatEndpointReady({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama" }), true);
	});
});
