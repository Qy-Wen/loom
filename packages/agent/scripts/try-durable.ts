/** Live smoke test: Loom Chat -> durable -> temporary SQLite, then reopen and verify history. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	buildChatModels,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	openNodeSqliteStorage,
	ProviderDoc,
	section,
	type Harness as HarnessHandle,
} from "@loom/agent/durable";

async function main() {
	const apiKey = process.env.LOOM_CHAT_API_KEY ?? process.env.DEEPSEEK_API_KEY;
	if (!apiKey) throw new Error("Set LOOM_CHAT_API_KEY or DEEPSEEK_API_KEY in .env.");
	const chat = {
		baseUrl: process.env.LOOM_CHAT_BASE_URL ?? "https://api.deepseek.com",
		model: process.env.LOOM_CHAT_MODEL ?? "deepseek-v4-flash",
		apiKey,
	};
	const directory = await mkdtemp(join(tmpdir(), "loom-try-durable-"));
	const file = join(directory, "session.sqlite");
	const controller = new AbortController();
	const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	const timeout = setTimeout(() => controller.abort(new Error("Smoke test timed out")), 60_000);
	let harness: HarnessHandle | undefined;
	try {
		const { models, model } = buildChatModels(chat);
		const registry = createRegistry();
		let echoCalls = 0;
		registry.install(defineExtension({
			name: "smoke",
			sections: [section("preamble", () => "When asked to echo, call the echo tool, then reply briefly.", { tag: false })],
			tools: [defineTool({
				name: "echo", description: "Echo text verbatim", parameters: Type.Object({ text: Type.String() }),
				execute: async ({ text }) => {
					echoCalls++;
					console.log(`[echo] ${text}`);
					return { output: [{ type: "text", text: `echo: ${text}` }] };
				},
			})],
		}));
		harness = await Harness.open(await openNodeSqliteStorage(file), {
			models, registry, settings: { stream: { timeoutMs: 30_000 }, retry: { maxRetries: 0 } },
		}, context);
		const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
		const draft = { type: "input", content: "Please echo the phrase: Loom is alive.", requestId: "smoke-1" } as const;
		const submission = await root.submit(draft, context);
		const settled = await submission.wait(context);
		assert.equal(settled.status, "done", JSON.stringify(settled));
		assert.ok(echoCalls > 0, "Expected the model to call echo");
		const entries = (await root.entries({ order: "ascending" }, 50, undefined, context)).items;
		const answer = entries.at(-1);
		assert.ok(AssistantEntry.is(answer));
		const message = answer.model?.[0];
		assert.equal(message?.role, "assistant");
		assert.ok(Array.isArray(message?.content));
		console.log(`[answer] ${JSON.stringify(message?.content)}`);
		const provider = await harness.snapshot(ProviderDoc, root.id, context);
		const rootId = root.id;
		await harness.close(BACKGROUND_CONTEXT);
		harness = undefined;
		const reopenedModels = buildChatModels(chat);
		harness = await Harness.open(await openNodeSqliteStorage(file), { models: reopenedModels.models, registry }, context);
		const reopened = await harness.root(context);
		assert.equal(reopened.id, rootId);
		assert.deepEqual((await reopened.entries({ order: "ascending" }, 50, undefined, context)).items, entries);
		assert.deepEqual(await harness.snapshot(ProviderDoc, rootId, context), provider);
		assert.equal((await reopened.submit(draft, context)).id, submission.id);
		assert.equal((await harness.submission(submission.id, context))?.id, submission.id);
		console.log(`PASS: ${chat.model}: submit/wait, tool execution, SQLite reopen, persisted provider identity, request deduplication`);
	} finally {
		clearTimeout(timeout);
		await harness?.close(BACKGROUND_CONTEXT);
		await rm(directory, { recursive: true, force: true });
	}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
