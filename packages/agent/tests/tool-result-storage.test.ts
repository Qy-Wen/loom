import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context, createModels, createReadTool, createRegistry, createToolResultStorage,
	defineExtension, defineTool, Harness, MemoryStorage, NodeExecutionEnv, toDurableTool,
	type Conversation, type JsonObject, type ToolExecutionResult, type ToolRegistration,
} from "../src/durable.ts";

type Faux = ReturnType<typeof fauxProvider>;

async function fixture(tools: ToolRegistration[], run: (root: string, conversation: Conversation, faux: Faux) => Promise<void>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "loom-tool-results-")));
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.tools", tools }));
	registry.install(createToolResultStorage(root));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd: root }), settings: { compaction: { enabled: false } } }, context);
	harness.resume();
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
		await run(root, conversation, faux);
	} finally { await harness.close(context); await rm(root, { recursive: true, force: true }); }
}

function resultTool(name: string, result: ToolExecutionResult): ToolRegistration {
	return defineTool({ name, description: name, parameters: Type.Object({}), replay: "unsafe", execute: async () => result });
}

async function run(conversation: Conversation, faux: Faux, calls: Array<{ name: string; args?: JsonObject }>) {
	faux.setResponses([answer(calls.map(({ name, args }) => fauxToolCall(name, args ?? {})), { stopReason: "toolUse" }), answer("done")]);
	assert.equal((await (await conversation.submit({ type: "input", content: "run tools" }, context)).wait(context)).status, "done");
	return (await conversation.context(context)).messages.filter((message) => message.role === "toolResult").slice(-calls.length);
}

const textOf = (content: NonNullable<ToolExecutionResult["output"]>) => content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
const outputPath = (content: NonNullable<ToolExecutionResult["output"]>) => {
	const match = /Full output: ([^\n]+)/.exec(textOf(content));
	assert.ok(match, "result must include the saved output path");
	return match[1]!;
};

for (const text of ["small", "x".repeat(50 * 1024), "line\n".repeat(2_000)]) {
	test(`results within the limits stay inline (${text.length} characters)`, async () => {
		await fixture([resultTool("inline", { output: [{ type: "text", text }] })], async (root, conversation, faux) => {
			const [result] = await run(conversation, faux, [{ name: "inline" }]);
			assert.equal(textOf(result!.content), text);
			await assert.rejects(stat(join(root, ".loom", "agents", "tool-results")), { code: "ENOENT" });
		});
	});
}

for (const text of ["x".repeat(50 * 1024 + 1), "line\n".repeat(2_001), "汉🙂".repeat(10_000)]) {
	test(`native and adapted tools save complete text before truncation (${text.length} characters)`, async () => {
		const image = { type: "image" as const, data: "YWJj".repeat(20 * 1024), mimeType: "image/png" };
		const content = [{ type: "text" as const, text: text.slice(0, 100) }, image, { type: "text" as const, text: text.slice(100) }];
		const details = { id: "asset", preserved: true };
		await fixture([
			resultTool("native", { output: content, details }),
			toDurableTool({ name: "demo__result", description: "Adapted", parameters: Type.Object({}), execute: () => ({ content, details }) }),
		], async (root, conversation, faux) => {
			const results = await run(conversation, faux, [{ name: "native" }, { name: "demo__result" }]);
			const paths: string[] = [];
			for (const result of results) {
				assert.equal(result.isError, false);
				assert.deepEqual(result.details, details);
				assert.deepEqual(result.content.find((part) => part.type === "image"), image);
				const path = outputPath(result.content);
				paths.push(path);
				assert.equal(dirname(path), join(root, ".loom", "agents", "tool-results", String(conversation.id)));
				assert.equal(await readFile(path, "utf8"), text);
				const preview = result.content[0];
				assert.ok(preview?.type === "text");
				assert.ok(Buffer.byteLength(preview.text) <= 2 * 1024);
				assert.ok(!preview.text.includes("�"));
				assert.match(textOf(result.content), /offset\/limit/);
				if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
			}
			assert.equal(new Set(paths).size, 2);
			assert.ok((await readdir(dirname(paths[0]!))).every((name) => name.endsWith(".txt")));
		});
	});
}

test("stored previews preserve error status and schema-validated structured output", async () => {
	const text = "failure detail\n".repeat(5_000);
	const tool = defineTool({
		name: "failure", description: "Failure", parameters: Type.Object({}), replay: "unsafe",
		structuredOutputSchema: Type.Object({ complete: Type.Boolean() }),
		execute: async () => ({ output: [{ type: "text", text }], structuredOutput: { complete: false }, isError: true, diagnostics: [{ severity: "error", message: "original error" }] }),
	});
	await fixture([tool, defineTool({
		name: "nested", description: "Nested", parameters: Type.Object({}), replay: "unsafe",
		execute: async (_args, api, ctx) => {
			const result = await api.executeTool("failure", {}, ctx);
			assert.equal(result.isError, true);
			assert.deepEqual(result.structuredOutput, { complete: false });
			return { output: [{ type: "text", text: "nested complete" }] };
		},
	})], async (_root, conversation, faux) => {
		const [result] = await run(conversation, faux, [{ name: "failure" }]);
		assert.equal(result!.isError, true);
		assert.match(textOf(result!.content), /original error/);
		assert.equal(await readFile(outputPath(result!.content), "utf8"), text);
		const [nested] = await run(conversation, faux, [{ name: "nested" }]);
		assert.equal(nested!.isError, false);
	});
});

test("failed persistence warns and still bounds output without turning tool success into failure", async () => {
	const text = "x".repeat(60 * 1024);
	await fixture([resultTool("large", { output: [{ type: "text", text }] })], async (root, conversation, faux) => {
		await mkdir(join(root, ".loom", "agents"), { recursive: true });
		await writeFile(join(root, ".loom", "agents", "tool-results"), "blocked");
		const [result] = await run(conversation, faux, [{ name: "large" }]);
		assert.equal(result!.isError, false);
		assert.equal(result!.content[0]?.type === "text" && result!.content[0].text, "x".repeat(50 * 1024));
		assert.match(textOf(result!.content), /Could not save full output/);
		assert.match(textOf(result!.content), /Output truncated/);
		assert.doesNotMatch(textOf(result!.content), /Full output:/);
	});
});

test("existing full-output files and bounded read results are not persisted again", async () => {
	const text = "line\n".repeat(2_100);
	await fixture([
		createReadTool(),
		resultTool("shell", { output: [{ type: "text", text }], diagnostics: [{ severity: "info", code: "full_output", message: "Full output: existing.txt" }] }),
	], async (root, conversation, faux) => {
		await writeFile(join(root, "source.txt"), text);
		const results = await run(conversation, faux, [{ name: "shell" }, { name: "read", args: { path: "source.txt" } }]);
		assert.equal(outputPath(results[0]!.content), "existing.txt");
		assert.match(textOf(results[1]!.content), /offset=2001/);
		await assert.rejects(stat(join(root, ".loom", "agents", "tool-results")), { code: "ENOENT" });
	});
});

test("read can retrieve stored output in bounded portions without creating another copy", async () => {
	const text = Array.from({ length: 2_100 }, (_, index) => `line ${index + 1}\n`).join("");
	await fixture([resultTool("large", { output: [{ type: "text", text }] }), createReadTool()], async (root, conversation, faux) => {
		const [saved] = await run(conversation, faux, [{ name: "large" }]);
		const path = outputPath(saved!.content);
		const [read] = await run(conversation, faux, [{ name: "read", args: { path, offset: 2_001, limit: 10 } }]);
		assert.equal(read!.isError, false);
		assert.match(textOf(read!.content), /line 2001\n/);
		assert.doesNotMatch(textOf(read!.content), /line 2011\n/);
		assert.equal((await readdir(join(root, ".loom", "agents", "tool-results", String(conversation.id)))).length, 1);
	});
});
