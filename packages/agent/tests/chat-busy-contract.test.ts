import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context, createModels, LibraryAgent } from "../src/durable.ts";
import { withGenerationDefaults } from "./fixtures/chat-provider-prototype.ts";

test("P0: inspect exposes busy generations; configure is not a busy guard and active requests keep their snapshot", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-chat-busy-p0-"));
	let owner: LibraryAgent | undefined;
	const release = Promise.withResolvers<void>();
	try {
		const first = fauxProvider({ provider: "first", models: [{ id: "model", contextWindow: 128000, maxTokens: 8192 }] });
		const second = fauxProvider({ provider: "second", models: [{ id: "model", contextWindow: 32000, maxTokens: 8192 }] });
		const models = createModels(); models.setProvider(withGenerationDefaults(first.provider, { maxTokens: 64 })); models.setProvider(second.provider);
		owner = await LibraryAgent.open(root, { models, agent: { model: { provider: "first", modelId: "model" } }, settings: { retry: { enabled: false } } }, context);
		const conversation = await owner.createConversation({}, context);
		const entered = Promise.withResolvers<void>();
		first.setResponses([async (_messages, options, _state, model) => {
			assert.equal(options?.maxTokens, 64); assert.equal(model.contextWindow, 128000);
			entered.resolve(); await release.promise;
			assert.equal(options?.maxTokens, 64); assert.equal(model.contextWindow, 128000);
			return answer("first response");
		}]);
		const submission = await conversation.submit({ type: "input", content: "first" }, context);
		await entered.promise;
		const snapshot = await owner.harness.inspect(context);
		const generation = snapshot.tasks.find((task) => task.record.kind === "pi.generation" && task.record.state.status === "running");
		assert.ok(generation);
		// Public configure accepts this: Loom must gate model changes before invoking it in P4.
		await conversation.configure({ model: { provider: "second", modelId: "model" } }, context);
		assert.equal((await conversation.agent(context)).model!.provider, "second");
		models.setProvider(withGenerationDefaults(first.provider, { maxTokens: 256 }));
		release.resolve(); assert.equal((await submission.wait(context)).status, "done");
		second.setResponses([() => answer("second response")]);
		assert.equal((await (await conversation.submit({ type: "input", content: "second" }, context)).wait(context)).status, "done");
		assert.equal(second.state.callCount, 1);
	} finally {
		release.resolve(); await owner?.close(context); await rm(root, { recursive: true, force: true });
	}
});
