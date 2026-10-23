import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	createCodingTools,
	createNodePhotonImages,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	NodeExecutionEnv,
	openNodeJsonlStorage,
	openNodeSqliteStorage,
	ToolResultEntry,
	watchEvents,
	type Storage,
} from "@loom/agent/durable";

const context = BACKGROUND_CONTEXT;
const Metadata = defineDoc<{ title: string }>({
	kind: "test.metadata",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ title: "Untitled" }),
	checkpointWhen: () => false,
});

function chat() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, model: { provider: faux.models[0].provider, modelId: faux.models[0].id } };
}

for (const backend of ["memory", "jsonl", "sqlite"] as const) {
	test(`${backend}: atomic documents, passive submissions, forks, and reopen`, { timeout: 10_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), "loom-durable-"));
		const memory = new MemoryStorage();
		const open = async (): Promise<Storage> => {
			if (backend === "memory") return memory;
			if (backend === "jsonl") return openNodeJsonlStorage(join(directory, "jsonl"), context);
			return openNodeSqliteStorage(join(directory, "session.sqlite"));
		};
		let harness: Harness | undefined;
		try {
			const models = createModels();
			const registry = createRegistry();
			harness = await Harness.open(await open(), {
				models, registry,
				conversationCreated: async (tx, conversation) => { await tx.doc(Metadata, conversation.id); },
			}, context);
			const root = await harness.root(context);
			await root.commit(async (tx) => { (await tx.doc(Metadata, root.id)).title = "Stored"; }, context);
			await assert.rejects(root.commit(async (tx) => {
				(await tx.doc(Metadata, root.id)).title = "Rolled back";
				throw new Error("rollback");
			}, context), /rollback/);
			assert.equal((await harness.snapshot(Metadata, root.id, context))?.title, "Stored");
			const draft = { type: "write", entry: { kind: "test.note", data: "saved" }, requestId: "note-1" } as const;
			const submission = await root.submit(draft, context);
			assert.equal((await root.submit(draft, context)).id, submission.id);
			assert.equal((await submission.wait(context)).status, "done");
			const entries = await root.entries({ order: "ascending" }, 20, undefined, context);
			assert.equal(entries.items[0]?.kind, "test.note");
			const fork = await root.fork(entries.items[0]!.id, { ownership: { kind: "ownerless" } }, context);
			assert.equal((await fork.entries({}, 20, undefined, context)).items[0]?.data, "saved");
			assert.equal((await harness.snapshot(Metadata, fork.id, context))?.title, "Untitled");
			assert.equal((await root.entries({}, 20, undefined, context)).items.length, 1);
			const rootId = root.id;
			await harness.close(context);
			harness = undefined;
			if (backend !== "memory") {
				harness = await Harness.open(await open(), { models, registry }, context);
				assert.equal((await harness.root(context)).id, rootId);
				assert.equal((await harness.snapshot(Metadata, rootId, context))?.title, "Stored");
			}
		} finally {
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("faux provider: coding tools and committed agent events", { timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-durable-tools-"));
	const { faux, models, model } = chat();
	const registry = createRegistry();
	registry.install(createCodingTools());
	const harness = await Harness.open(new MemoryStorage(), {
		models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
	}, context);
	try {
		const root = await harness.root(context, { agent: { model, cwd: directory } });
		const events = await watchEvents(harness, root.id, context);
		try {
			const observed = Promise.withResolvers<void>();
			events.start(async (batch) => { if (batch.length > 0) observed.resolve(); });
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "hello" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("finished"),
			]);
			const settled = await (await root.submit({ type: "input", content: "write and read a note" }, context)).wait(context);
			assert.equal(settled.status, "done");
			await observed.promise;
			assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "hello");
			const entries = (await root.entries({ order: "ascending" }, 20, undefined, context)).items;
			assert.equal(entries.filter((entry) => ToolResultEntry.is(entry)).length, 2);
			const answer = entries.at(-1);
			assert.ok(AssistantEntry.is(answer));
			assert.deepEqual(answer.model?.[0]?.content, [{ type: "text", text: "finished" }]);
			assert.equal(faux.state.callCount, 3);
		} finally {
			await events.stop();
		}
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("nested tool calls return validated structured output", { timeout: 10_000 }, async () => {
	const { faux, models, model } = chat();
	const registry = createRegistry();
	const inner = defineTool({
		name: "inner", description: "Return a number", parameters: Type.Object({}),
		structuredOutputSchema: Type.Object({ value: Type.Number() }),
		execute: async () => ({ output: [{ type: "text", text: "42" }], structuredOutput: { value: 42 } }),
	});
	let value: unknown;
	const outer = defineTool({
		name: "outer", description: "Call inner", parameters: Type.Object({}),
		execute: async (_args, api, ctx) => {
			const result = await api.executeTool("inner", {}, ctx);
			assert.equal(result.isError, false);
			value = result.structuredOutput;
			return { output: [{ type: "text", text: "done" }] };
		},
	});
	registry.install(defineExtension({ name: "nested", tools: [inner, outer] }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("outer", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		assert.equal((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status, "done");
		assert.deepEqual(value, { value: 42 });
	} finally {
		await harness.close(context);
	}
});

for (const worker of [false, true]) {
	test(`Photon image processor (worker=${worker})`, { timeout: 15_000 }, async () => {
		const bytes = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
		const images = await createNodePhotonImages({ worker, idleMs: 1 });
		const result = await images.prepare(bytes, "image/gif", { maxWidth: 2000, maxHeight: 2000, maxBytes: 1024 * 1024 });
		assert.ok(result);
		assert.ok(result.data.length > 0);
		assert.equal(result.mimeType, "image/gif");
	});
}
