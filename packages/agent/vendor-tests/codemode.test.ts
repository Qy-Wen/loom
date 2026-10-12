import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import {
	CodemodeSandbox,
	createCodemodeExtension,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	ToolResultEntry,
} from "@loom/agent/durable";

const context = BACKGROUND_CONTEXT;

test("vendored sandbox executes tools in a worker and isolates host capabilities", { timeout: 10_000 }, async () => {
	const sandbox = new CodemodeSandbox({
		tools: [{ name: "double", execute: async (args) => (args as { value: number }).value * 2 }],
	});
	try {
		const { code, options } = parseCodemodeSource('// @options: {"timeout_ms": 1000}\ntext(await tools.double({ value: 21 })); return typeof process;');
		assert.equal(options.timeoutMs, 1000);
		const result = await sandbox.execute(code);
		if (!result.ok) assert.fail(result.error.message);
		assert.equal(result.value, "undefined");
		assert.deepEqual(result.output, [{ type: "text", text: "42" }]);
		assert.equal(result.calls[0]?.status, "ok");
		const failure = await sandbox.execute('throw new Error("script failed");');
		assert.equal(failure.ok, false);
		if (failure.ok) assert.fail("Expected script error");
		assert.equal(failure.error.kind, "script");
		assert.match(failure.error.message, /script failed/);
	} finally {
		await sandbox.close();
	}
});

test("vendored sandbox deterministic runs use the host delivery API", { timeout: 10_000 }, async () => {
	const sandbox = new CodemodeSandbox();
	try {
		const execute = async () => {
			const run = sandbox.start('const result = await tools.number({ seed: Math.random() }); return [result, Date.now()];', {
				startedAt: 1000,
				seed: 7,
				tools: [{ name: "number" }],
				onCall: (call) => run.deliver(1, 2000, call.id, { ok: true, value: call.args }),
			});
			return run.result;
		};
		const first = await execute();
		const second = await execute();
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		if (!first.ok || !second.ok) assert.fail("Deterministic run failed");
		assert.deepEqual(first.value, second.value);
		assert.equal((first.value as unknown[])[1], 2000);
	} finally {
		await sandbox.close();
	}
});

test("durable code mode calls a nested tool and records the script output", { timeout: 10_000 }, async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const sandbox = new CodemodeSandbox();
	const seen: number[] = [];
	registry.install(defineExtension({
		name: "numbers",
		tools: [defineTool({
			name: "double", description: "Double a number", parameters: Type.Object({ value: Type.Number() }),
			structuredOutputSchema: Type.Object({ value: Type.Number() }),
			execute: async ({ value }) => {
				seen.push(value);
				return { output: [{ type: "text", text: String(value * 2) }], structuredOutput: { value: value * 2 } };
			},
		})],
	}));
	registry.install(createCodemodeExtension({ sandbox, models: false }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, {
			agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } },
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: "const result = await tools.double({ value: 21 }); text(result.value);" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		assert.equal((await (await root.submit({ type: "input", content: "calculate" }, context)).wait(context)).status, "done");
		assert.deepEqual(seen, [21]);
		const entries = (await root.entries({ order: "ascending" }, 20, undefined, context)).items;
		const results = entries.filter((entry) => ToolResultEntry.is(entry));
		assert.equal(results.length, 1); // Nested double output stays out of the transcript.
		const message = results[0]!.model![0]!;
		assert.equal(message.role, "toolResult");
		if (message.role !== "toolResult") assert.fail("Expected tool result");
		assert.equal(message.toolName, "codemode");
		assert.equal(message.isError, false);
		assert.match(message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), /42/);
	} finally {
		await harness.close(context);
		await sandbox.close();
	}
});
