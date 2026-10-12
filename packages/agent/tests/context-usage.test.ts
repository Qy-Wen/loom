import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { BACKGROUND_CONTEXT as context, CompactionEntry, createModels, createRegistry, Harness, MemoryStorage } from "../src/durable.ts";
import { contextUsage } from "../src/context-usage.ts";

async function fixture(run: (conversation: Awaited<ReturnType<Harness["createConversation"]>>) => Promise<void>) {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	try { await run(await harness.createConversation({ ownership: { kind: "ownerless" } }, context)); }
	finally { await harness.close(context); }
}
const model = { provider: "faux", modelId: "test" };
const answer = (text: string, input = 100, options: Parameters<typeof fauxAssistantMessage>[1] = {}) => ({
	...fauxAssistantMessage(text, options), provider: model.provider, model: model.modelId,
	usage: { input, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("context usage estimates empty and unmeasured messages, including system/tool schemas and images", async () => {
	await fixture(async (conversation) => {
		assert.deepEqual(contextUsage(await conversation.context(context), model, 1000), { tokens: 0, window: 1000, percent: 0 });
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, { kind: "test.system", model: [{ role: "system", content: "Instructions", toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }], timestamp: 1 }] });
			await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 2 }] });
		}, context);
		const view = await conversation.context(context);
		const expected = view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		assert.ok(expected > 1000, "images and tools contribute to the estimate");
		assert.deepEqual(contextUsage(view, model, 2000), { tokens: expected, window: 2000, percent: expected / 2000 * 100 });
	});
});

test("context usage takes latest matching provider usage, including cache, and adds only trailing messages", async () => {
	await fixture(async (conversation) => {
		const measured = answer("answer");
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "old ".repeat(1000), timestamp: 1 }] });
			await tx.appendEntry(conversation.id, { kind: "test.assistant", model: [answer("old answer", 9999)] });
			await tx.appendEntry(conversation.id, { kind: "test.assistant", model: [measured] });
			await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "follow-up", timestamp: Date.now() + 1 }] });
		}, context);
		const view = await conversation.context(context);
		const expected = calculateContextTokens(measured.usage) + estimateMessageTokens(view.messages.at(-1)!);
		assert.equal(calculateContextTokens(measured.usage), 180);
		assert.deepEqual(contextUsage(view, model, 1000), { tokens: expected, window: 1000, percent: expected / 1000 * 100 });
	});
});

test("tool results after a measured tool call add to context without double-counting its assistant", async () => {
	await fixture(async (conversation) => {
		const call = fauxToolCall("read", { path: "notes.md" });
		const measured = { ...answer(""), content: [call], stopReason: "toolUse" as const };
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, { kind: "test.assistant", model: [measured] });
			await tx.appendEntry(conversation.id, { kind: "test.tool", model: [{ role: "toolResult", toolCallId: call.id, toolName: "read", content: [{ type: "text", text: "source ".repeat(100) }], isError: false, timestamp: Date.now() }] });
		}, context);
		const view = await conversation.context(context);
		assert.equal(contextUsage(view, model, 1000).tokens, calculateContextTokens(measured.usage) + estimateMessageTokens(view.messages.at(-1)!));
	});
});

test("model changes do not reuse another provider/model's token measurement", async () => {
	await fixture(async (conversation) => {
		await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test.assistant", model: [answer("short", 9999)] }), context);
		const view = await conversation.context(context);
		const expected = view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		assert.equal(contextUsage(view, { ...model, modelId: "next" }, 2000).tokens, expected);
		assert.equal(contextUsage(view, { ...model, provider: "next" }, 2000).tokens, expected);
	});
});

test("compaction invalidates retained pre-summary usage until a fresh measured answer arrives", async () => {
	await fixture(async (conversation) => {
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "old ".repeat(1000), timestamp: 1 }] });
			const kept = await tx.appendEntry(conversation.id, { kind: "test.assistant", model: [answer("retained", 9999)] });
			await tx.appendEntry(conversation.id, { kind: CompactionEntry.kind, head: kept.id, data: { reason: "manual" }, model: [{ role: "user", content: "Summary", timestamp: Date.now() + 1 }] });
		}, context);
		const view = await conversation.context(context);
		const expected = view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		assert.equal(contextUsage(view, model, 1000).tokens, expected);
		const fresh = answer("fresh", 70);
		await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test.assistant", model: [fresh] }), context);
		assert.equal(contextUsage(await conversation.context(context), model, 1000).tokens, calculateContextTokens(fresh.usage));
	});
});

test("failed, aborted and deferred answers are excluded by native context; fork uses its own as-of head", async () => {
	await fixture(async (conversation) => {
		const first = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "first", timestamp: 1 }] }), context);
		await conversation.commit(async (tx) => {
			for (const stopReason of ["aborted", "error", "deferred"] as const) await tx.appendEntry(conversation.id, { kind: "test.assistant", model: [answer("bad ".repeat(1000), 9999, { stopReason })] });
			await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "tail ".repeat(100), timestamp: 2 }] });
		}, context);
		const fork = await conversation.fork(first.id, { ownership: { kind: "ownerless" } }, context);
		const forkUsage = contextUsage(await fork.context(context), model, 1000);
		assert.equal(forkUsage.tokens, estimateMessageTokens(first.model![0]!));
		assert.ok(contextUsage(await conversation.context(context), model, 1000).tokens! > forkUsage.tokens!);
	});
});
