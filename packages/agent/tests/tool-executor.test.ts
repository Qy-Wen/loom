import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCatalog, ToolExecutor, jsonToolResult, type LoomTool, type ToolLibraryBinding } from "../src/tools/index.ts";

const direct: ToolLibraryBinding = { run: async (work, signal) => work(signal ?? new AbortController().signal) };
const echo = (execute: LoomTool["execute"] = (args) => jsonToolResult(args)): LoomTool => ({
	name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, execute,
});

test("Agent and external calls share argument validation and business results", async () => {
	let calls = 0;
	const executor = new ToolExecutor(new ToolCatalog([{ tool: echo((args) => { calls++; return jsonToolResult(args); }), scope: "library", exposure: "external" }]));
	const agent = executor.agentTools(() => direct)[0]!;
	const args = { value: "hello" };
	assert.deepEqual(await agent.execute(args), await executor.execute("echo", args, {
		audience: "external", library: direct,
	}));
	assert.equal(calls, 2);
	for (const invalid of [{}, { value: 42 }, { value: "ok", extra: true }]) {
		await assert.rejects(() => Promise.resolve().then(() => agent.execute(invalid)), /Invalid arguments/);
		await assert.rejects(executor.execute("echo", invalid, { audience: "external", library: direct }), /Invalid arguments/);
	}
	assert.equal(calls, 2);
});

test("external execution rejects internal, undecided, and unknown tools", async () => {
	let calls = 0;
	const definitions = ["external", "internal", "undecided"] as const;
	const executor = new ToolExecutor(new ToolCatalog(definitions.map((exposure) => ({
		tool: { ...echo(() => { calls++; return "executed"; }), name: exposure }, scope: "library", exposure,
	}))));
	assert.deepEqual(executor.catalog.list("external").map(({ tool }) => tool.name), ["external"]);
	for (const name of ["internal", "undecided", "unknown"]) {
		await assert.rejects(executor.execute(name, { value: "ok" }, { audience: "external", library: direct }), /not available/);
	}
	assert.equal(calls, 0);
	assert.throws(() => new ToolCatalog([executor.catalog.get("external", "agent"), executor.catalog.get("external", "agent")]), /Duplicate tool/);
});

test("cancelled calls never execute and library tools require a binding", async () => {
	let calls = 0;
	const cancel = new AbortController();
	cancel.abort();
	const executor = new ToolExecutor(new ToolCatalog([{
		tool: echo(() => { calls++; return "executed"; }), scope: "library", exposure: "external",
	}]));
	await assert.rejects(executor.execute("echo", { value: "ok" }, {
		audience: "external", library: direct, signal: cancel.signal,
	}), { name: "AbortError" });
	await assert.rejects(executor.execute("echo", { value: "ok" }, { audience: "external" }), /library binding/);
	assert.equal(calls, 0);
});

test("application tools work without opening a library and validation errors omit credentials", async () => {
	const executor = new ToolExecutor(new ToolCatalog([{ tool: echo(), scope: "application", exposure: "undecided" }]));
	const agent = executor.agentTools(() => { throw new Error("No library open"); })[0]!;
	assert.deepEqual((await agent.execute({ value: "ok" }) as { data: unknown }).data, { value: "ok" });
	await assert.rejects(executor.execute("echo", { secret: "DO_NOT_PRINT" }, { audience: "agent" }), (error: Error) => {
		assert.match(error.message, /Invalid arguments/);
		assert.doesNotMatch(error.message, /DO_NOT_PRINT/);
		return true;
	});
});

test("Agent and external calls discard results when cancelled during execution", async () => {
	for (const audience of ["agent", "external"] as const) {
		const cancel = new AbortController();
		const executor = new ToolExecutor(new ToolCatalog([{
			tool: echo(() => { cancel.abort(); return "executed"; }), scope: "library", exposure: "external",
		}]));
		await assert.rejects(executor.execute("echo", { value: "ok" }, {
			audience, library: direct, signal: cancel.signal,
		}), { name: "AbortError" });
	}
});
