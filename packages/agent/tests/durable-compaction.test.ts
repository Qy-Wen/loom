import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage as answer, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	BACKGROUND_CONTEXT as context, CompactionEntry, createRegistry, Harness, MemoryStorage,
	type HarnessSettings,
} from "../src/durable.ts";

async function fixture(settings: HarnessSettings, run: (harness: Harness, faux: ReturnType<typeof fauxProvider>) => Promise<void>) {
	const faux = fauxProvider({ models: [{ id: "test", contextWindow: 1000, maxTokens: 200 }] });
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings }, context);
	harness.resume();
	try { await run(harness, faux); } finally { await harness.close(context); }
}

for (const reason of ["threshold", "overflow"] as const) {
	test(`durable ${reason} compaction records a summary and retries the answer`, { timeout: 10_000 }, async () => {
		await fixture({ compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 100, backgroundTokens: 0 }, retry: { enabled: false } }, async (harness, faux) => {
			const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
			await conversation.commit(async (tx) => {
				for (let i = 0; i < 8; i++) await tx.appendEntry(conversation.id, { kind: "eval.user", model: [{ role: "user", content: (reason === "threshold" ? "context ".repeat(70) : "brief ".repeat(15)).repeat(2), timestamp: i }] });
			}, context);
			const responses = [answer("Summary: preserve project LOOM-7F3K and main file projects/aurora/main.mp4."), answer("completed")];
			if (reason === "overflow") responses.unshift(answer([], { stopReason: "error", errorMessage: "prompt is too long: 250000 tokens > 200000 maximum" }));
			faux.setResponses(responses);
			const submission = await conversation.submit({ type: "input", content: "continue" }, context);
			assert.equal((await submission.wait(context)).status, "done");
			const active = await conversation.context(context);
			assert.ok(active.entries.some((entry) => CompactionEntry.is(entry)), JSON.stringify(active));
			assert.ok(active.entries.some((entry) => CompactionEntry.is(entry) && entry.data?.reason === reason));
			assert.equal(faux.getPendingResponseCount(), 0);
		});
	});
}

test("durable follow-up joins foreground work; Stop withdraws queued follow-ups", { timeout: 10_000 }, async () => {
	await fixture({}, async (harness, faux) => {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faux.setResponses([async () => { entered.resolve(); await release.promise; return answer("first"); }, answer("follow-up")]);
		const first = await conversation.submit({ type: "input", content: "first" }, context);
		await entered.promise;
		const follow = await conversation.submit({ type: "input", content: "queued", whenBusy: "followUp" }, context);
		await assert.rejects(conversation.submit({ type: "input", content: "rejected", whenBusy: "reject" }, context), /busy/i);
		release.resolve();
		assert.equal((await first.wait(context)).status, "done");
		assert.equal((await follow.wait(context)).status, "done");
		const enteredAgain = Promise.withResolvers<void>(); const releaseAgain = Promise.withResolvers<void>();
		faux.setResponses([async () => { enteredAgain.resolve(); await releaseAgain.promise; return answer("too late"); }]);
		const running = await conversation.submit({ type: "input", content: "running" }, context);
		await enteredAgain.promise;
		const withdrawn = await conversation.submit({ type: "input", content: "drop me", whenBusy: "followUp" }, context);
		const stop = conversation.abort(context); releaseAgain.resolve(); await stop;
		assert.equal((await running.wait(context)).status, "unanswered");
		const settled = await withdrawn.wait(context);
		assert.equal(settled.status, "unanswered");
		assert.equal(settled.status === "unanswered" && settled.reason, "aborted");
		assert.doesNotMatch(JSON.stringify((await conversation.context(context)).messages), /drop me/);
	});
});
