import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context, createModels, createRegistry, defineExtension, defineTool,
	Harness, MemoryStorage, toDurableTool, type ToolExecutionApi,
} from "../src/durable.ts";
import type { LoomToolResult } from "../src/types.ts";

test("common tool adapter preserves text/images and serializes other blocks without media-specific policies", async () => {
	const image = { type: "image" as const, data: "YWJj", mimeType: "image/png" };
	const other = [
		{ type: "audio", data: "YWJj", mimeType: "audio/wav" },
		{ type: "resource", resource: { uri: "file:///clip.mp4", mimeType: "video/mp4", blob: "YWJj" } },
		{ type: "resource_link", uri: "file:///test" },
		{ type: "future_content", value: 42 },
	];
	const cases: Array<{ content: LoomToolResult["content"]; output: unknown[] }> = [
		{ content: "hello", output: [{ type: "text", text: "hello" }] },
		{ content: [], output: [] },
		{ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], output: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
		{
			content: [{ type: "text", text: "preview" }, image, ...other],
			output: [{ type: "text", text: "preview" }, image, ...other.map((part) => ({ type: "text", text: JSON.stringify(part) }))],
		},
	];
	for (const { content, output } of cases) {
		const tool = toDurableTool({ name: "result", description: "Result", parameters: Type.Object({}), execute: () => ({ content }) });
		assert.deepEqual((await tool.execute({}, {} as ToolExecutionApi, context)).output, output);
	}
});

for (const limit of ["bytes", "lines"] as const) {
	test(`adapted and native tools share durable ${limit} limits without truncating image data`, { timeout: 10_000 }, async () => {
		const text = limit === "bytes" ? "x".repeat(60 * 1024) : "line\n".repeat(2_100);
		const image = { type: "image" as const, data: "YWJj".repeat(20 * 1024), mimeType: "image/png" };
		const output = [{ type: "text" as const, text }, image];
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.results", tools: [
			defineTool({ name: "native", description: "Native", parameters: Type.Object({}), replay: "unsafe", execute: async () => ({ output }) }),
			toDurableTool({ name: "adapted", description: "Adapted", parameters: Type.Object({}), execute: () => ({ content: output }) }),
		] }));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { compaction: { enabled: false } } }, context);
		harness.resume();
		try {
			const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
			faux.setResponses([
				answer(fauxToolCall("native", {}), { stopReason: "toolUse" }),
				answer(fauxToolCall("adapted", {}), { stopReason: "toolUse" }),
				answer("done"),
			]);
			assert.equal((await (await conversation.submit({ type: "input", content: "compare results" }, context)).wait(context)).status, "done");
			const results = (await conversation.context(context)).messages.filter((message) => message.role === "toolResult");
			assert.equal(results.length, 2);
			assert.ok(results.every((result) => !result.isError));
			assert.deepEqual(results[0]!.content, results[1]!.content);
			const content = results[1]!.content;
			assert.deepEqual(content.find((part) => part.type === "image"), image);
			assert.equal(content[0]?.type, "text");
			assert.equal(content[0]?.type === "text" && content[0].text, limit === "bytes" ? "x".repeat(50 * 1024) : "line\n".repeat(2_000));
			assert.match(JSON.stringify(content), /truncat/i);
		} finally { await harness.close(context); }
	});
}
