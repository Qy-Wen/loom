import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context, createModels, LibraryRuntime, GenerationTask, defineExtension, hook,
} from "../src/durable.ts";
import { withGenerationDefaults } from "./fixtures/chat-provider-prototype.ts";

/** Approved A semantics: checkpoints retain selection, and recovery resolves current metadata/defaults. */
test("P0: native recovery preserves model reference/memo and reapplies current metadata/defaults", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-chat-request-p0-"));
	let owner: LibraryRuntime | undefined;
	try {
		const first = fauxProvider({ provider: "p0", models: [{ id: "same-model", contextWindow: 128000, maxTokens: 4096 }] });
		const originalRef = { provider: "p0", modelId: "same-model" };
		const entered = Promise.withResolvers<void>();
		let firstMemo: { maxTokens: number } | undefined;
		const pin = defineExtension({ name: "p0.memo", hooks: [hook(GenerationTask, { beforeRequest: async (_request, api, ctx) => {
			firstMemo = await api.memo("p0.defaults", { maxTokens: 64 }, ctx);
			return undefined;
		} })] });
		const models = createModels(); models.setProvider(withGenerationDefaults(first.provider, { maxTokens: 64 }));
		owner = await LibraryRuntime.open(root, { models, extensions: [pin], agent: { model: originalRef }, settings: { retry: { enabled: false } } }, context);
		const conversation = await owner.createConversation({}, context);
		first.setResponses([async (_messages, options, _state, model) => {
			assert.equal(options?.maxTokens, 64);
			assert.equal(model.contextWindow, 128000);
			entered.resolve();
			const signal = options!.signal!;
			await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
			return answer("interrupted");
		}]);
		const submission = await conversation.submit({ type: "input", content: "continue after restart" }, context);
		await entered.promise;
		assert.deepEqual(firstMemo, { maxTokens: 64 });
		const live = await owner.harness.inspect(context);
		const generation = live.tasks.find((task) => task.record.kind === "pi.generation")!.record;
		assert.equal(generation.state.status, "running");
		if (generation.state.status !== "running") throw new Error("Expected request checkpoint");
		const checkpoint = generation.state.checkpoint as Record<string, unknown>;
		assert.deepEqual(checkpoint.model, originalRef);
		assert.equal(checkpoint.phase, "request");
		assert.equal(checkpoint.modelSnapshot, undefined);
		assert.equal((checkpoint.streamOptions as Record<string, unknown>).maxTokens, undefined);
		await owner.close(context); owner = undefined;

		const second = fauxProvider({ provider: "p0", models: [{ id: "same-model", contextWindow: 32000, maxTokens: 8192 }] });
		let restoredMemo: { maxTokens: number } | undefined;
		const restoredPin = defineExtension({ name: "p0.memo", hooks: [hook(GenerationTask, { beforeRequest: async (_request, api, ctx) => {
			restoredMemo = await api.memo("p0.defaults", { maxTokens: 256 }, ctx);
			return undefined;
		} })] });
		const reopenedModels = createModels(); reopenedModels.setProvider(withGenerationDefaults(second.provider, { maxTokens: 256 }));
		second.setResponses([(_messages, options, _state, model) => {
			assert.equal(options?.maxTokens, 256, "native recovery reapplies current defaults; the memo does not pin request options");
			assert.equal(model.contextWindow, 32000, "the same reference resolves current catalog metadata");
			return answer("recovered");
		}]);
		owner = await LibraryRuntime.open(root, { models: reopenedModels, extensions: [restoredPin], resume: false }, context);
		const restoredConversation = await owner.harness.conversation(conversation.id, context);
		assert.deepEqual((await restoredConversation!.agent(context)).model, originalRef);
		owner.harness.resume();
		assert.equal((await (await owner.harness.submission(submission.id, context))!.wait(context)).status, "done");
		assert.deepEqual(restoredMemo, { maxTokens: 64 }, "public task memos themselves do survive reopen");
		assert.equal(second.state.callCount, 1);
	} finally {
		await owner?.close(context);
		await rm(root, { recursive: true, force: true });
	}
});

test("P0: real durable compaction cap takes priority over injected generation budget", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-chat-compact-p0-"));
	let owner: LibraryRuntime | undefined;
	try {
		const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000, maxTokens: 8192 }] });
		const models = createModels(); models.setProvider(withGenerationDefaults(faux.provider, { maxTokens: 4096 }));
		owner = await LibraryRuntime.open(root, { models, agent: { model: { provider: faux.provider.id, modelId: "test" } }, settings: { compaction: { reserveTokens: 1000, keepRecentTokens: 100, backgroundTokens: 0 }, retry: { enabled: false } } }, context);
		const conversation = await owner.createConversation({}, context);
		await conversation.commit(async (tx) => {
			for (let i = 0; i < 6; i++) await tx.appendEntry(conversation.id, { kind: "p0.user", model: [{ role: "user", content: "context ".repeat(100), timestamp: i }] });
		}, context);
		faux.setResponses([(_messages, options) => { assert.equal(options?.maxTokens, 800); assert.equal(options?.cacheRetention, "none"); return answer("Compacted summary."); }]);
		const task = await conversation.compact(undefined, context);
		assert.equal((await owner.harness.waitForTask(task, context)).state.outcome.status, "completed");
	} finally {
		await owner?.close(context);
		await rm(root, { recursive: true, force: true });
	}
});
