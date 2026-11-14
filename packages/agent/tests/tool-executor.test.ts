import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolApprovals, ToolCatalog, ToolExecutor, jsonToolResult, type LoomTool, type ToolLibraryBinding } from "../src/tools/index.ts";

const direct: ToolLibraryBinding = { run: async (work, signal) => work(signal ?? new AbortController().signal) };
const echo = (execute: LoomTool["execute"] = (args) => jsonToolResult(args)): LoomTool => ({
	name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, execute,
});

test("Agent and external calls share argument validation and business results", async () => {
	let calls = 0, authorizations = 0;
	const executor = new ToolExecutor(new ToolCatalog([{ tool: echo((args) => { calls++; return jsonToolResult(args); }), scope: "library", exposure: "external" }]));
	const agent = executor.agentTools(() => direct)[0]!;
	const args = { value: "hello" };
	assert.deepEqual(await agent.execute(args), await executor.execute("echo", args, {
		audience: "external", library: direct, authorize: async () => { authorizations++; },
	}));
	assert.equal(calls, 2);
	assert.equal(authorizations, 1);
	for (const invalid of [{}, { value: 42 }, { value: "ok", extra: true }]) {
		await assert.rejects(() => Promise.resolve().then(() => agent.execute(invalid)), /Invalid arguments/);
		await assert.rejects(executor.execute("echo", invalid, { audience: "external", library: direct, authorize: async () => { authorizations++; } }), /Invalid arguments/);
	}
	assert.equal(calls, 2);
	assert.equal(authorizations, 1);
});

test("external execution rejects internal, undecided, unknown and unauthorized tools", async () => {
	let calls = 0;
	const definitions = ["external", "internal", "undecided"] as const;
	const executor = new ToolExecutor(new ToolCatalog(definitions.map((exposure) => ({
		tool: { ...echo(() => { calls++; return "executed"; }), name: exposure }, scope: "library", exposure,
	}))));
	assert.deepEqual(executor.catalog.list("external").map(({ tool }) => tool.name), ["external"]);
	for (const name of ["internal", "undecided", "unknown"]) {
		await assert.rejects(executor.execute(name, { value: "ok" }, { audience: "external", library: direct, authorize: async () => {} }), /not available/);
	}
	await assert.rejects(executor.execute("external", { value: "ok" }, {
		audience: "external", library: direct, authorize: async () => { throw new Error("Permission denied"); },
	}), /Permission denied/);
	await assert.rejects(executor.execute("external", { value: "ok" }, { audience: "external", library: direct } as never), /require authorization/);
	assert.equal(calls, 0);
	assert.throws(() => new ToolCatalog([executor.catalog.get("external", "agent"), executor.catalog.get("external", "agent")]), /Duplicate tool/);
});

test("cancelling during authorization prevents execution and a library is mandatory", async () => {
	let calls = 0;
	const executor = new ToolExecutor(new ToolCatalog([{ tool: echo(() => { calls++; return "executed"; }), scope: "library", exposure: "external" }]));
	const cancel = new AbortController();
	await assert.rejects(executor.execute("echo", { value: "ok" }, {
		audience: "external", library: direct, signal: cancel.signal, authorize: async () => { cancel.abort(); },
	}), { name: "AbortError" });
	await assert.rejects(executor.execute("echo", { value: "ok" }, { audience: "external", authorize: async () => {} }), /library binding/);
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

for (const decision of ["approve", "reject", "abort"] as const) {
	test(`an external adapter uses shared approvals before execution: ${decision}`, { timeout: 5_000 }, async () => {
		let calls = 0, cleaned = false;
		const tool = { ...echo(() => { calls++; return "executed"; }), name: "run_ffmpeg" };
		const executor = new ToolExecutor(new ToolCatalog([{ tool, scope: "library", exposure: "external" }]));
		const approvals = new ToolApprovals();
		approvals.level = "basic";
		const controller = new AbortController();
		const ready = Promise.withResolvers<void>();
		const running = executor.execute(tool.name, { value: "ok" }, {
			audience: "external", library: direct, signal: controller.signal,
			authorize: (call, signal) => approvals.authorize(process.cwd(), {
				toolCallId: "client-1/request-1", toolName: call.name, args: call.args as { value: string },
			}, { pending: async () => { ready.resolve(); }, settled: async () => { cleaned = true; } }, signal),
		});
		const failed = decision === "approve" ? undefined : assert.rejects(running, decision === "abort" ? { name: "AbortError" } : /skipped/);
		await ready.promise;
		assert.equal(calls, 0);
		if (decision === "abort") controller.abort();
		else approvals.resolve("client-1/request-1", decision);
		if (decision === "approve") assert.equal(await running, "executed");
		else await failed;
		assert.equal(calls, decision === "approve" ? 1 : 0);
		assert.equal(cleaned, true);
	});
}
