import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { traceModels } from "../src/trace-models.ts";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context, createModels, LibraryRuntime, DurableTrace, TraceStore,
	defineExtension, defineTool, createSpecialistExtension, ToolGate, LoomApprovalsDoc, clearPendingApprovals,
} from "../src/durable.ts";
import { TracePrivacy } from "../src/trace-privacy.ts";
import { splitTraceBlobs } from "../src/trace-blob.ts";

async function temporary(run: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "loom-trace-"));
	try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function fixture(root: string, extra: Parameters<typeof LibraryRuntime.open>[1] = { models: createModels() }) {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const trace = new DurableTrace(await TraceStore.open(root));
	trace.setSecrets(["test-private-key"]);
	const owner = await LibraryRuntime.open(root, { ...extra, models: trace.models(models), resume: false,
		extensions: [...extra.extensions ?? [], trace.extension], settings: { ...extra.settings, extensions: [...extra.settings?.extensions ?? extra.extensions ?? [], trace.extension] },
		agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id }, ...extra.agent },
	}, context);
	await trace.start(owner.harness); owner.harness.resume();
	return { owner, trace, faux, close: async () => { await owner.close(context); trace.stop(); } };
}

test("trace privacy redacts credentials, omits images/signatures, and bounds UTF-8 payloads", () => {
	const privacy = new TracePrivacy(); privacy.setSecrets(["test-private-key"]);
	const payload = privacy.value({ api_key: "secret", authorization: "Bearer abc", note: "test-private-key sk-abcdefghijk", image: { type: "image", data: "BASE64", mimeType: "image/png" }, thoughtSignature: "SIGNATURE", body: "汉".repeat(10_000) });
	for (const secret of ["test-private-key", "sk-abcdefghijk", "BASE64", "SIGNATURE", "Bearer abc"]) assert.ok(!payload.includes(secret));
	assert.ok(Buffer.byteLength(payload) <= 8300);
	assert.match(payload, /bytes cut\)/);
	assert.doesNotMatch(payload, /\uFFFD/);
});

test("a request keeps the latest messages and previews long system text behind an expandable reference", () => {
	const privacy = new TracePrivacy(); privacy.setSecrets(["test-private-key"]);
	const preamble = "preamble ".repeat(5_000) + " test-private-key";
	const blobs: Record<string, string> = {};
	const text = privacy.request([
		{ role: "system", content: "", sections: { preamble, skills: "short" } },
		{ role: "user", content: "what is the weather" },
	], (hash, full) => { blobs[hash] = full; });
	assert.ok(text.includes("what is the weather"), "the user message survives long system text");
	assert.ok(Buffer.byteLength(text) < 4_000);
	const refs = splitTraceBlobs(text).filter((part) => "hash" in part);
	assert.equal(refs.length, 1);
	const ref = refs[0] as { hash: string; length: number };
	assert.equal(blobs[ref.hash]!.length, ref.length);
	assert.ok(blobs[ref.hash]!.startsWith("preamble preamble"));
	assert.ok(!blobs[ref.hash]!.includes("test-private-key"), "full text is still redacted");
	assert.ok(text.includes('"skills": "short"'));
	// The same text gives the same reference, so a record stores it once.
	const again = privacy.request([{ role: "system", content: "", sections: { preamble } }], () => {});
	assert.ok(again.includes(ref.hash));
	// Many messages: the latest are kept and the omission is stated.
	const many = privacy.request(Array.from({ length: 250 }, (_, i) => ({ role: "user", content: `m${i}` })), () => {});
	assert.ok(many.includes("50 earlier messages omitted") && many.includes('"m249"') && !many.includes('"m49"'));
	// A cut payload says how much was cut.
	assert.match(privacy.value({ body: "x".repeat(10_000) }), /bytes cut\)/);
});

test("model observation failures cannot change streaming or completion", async () => {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	for (const failAt of ["start", "partial", "end"]) {
		const wrapped = traceModels(models, { start: () => {
			if (failAt === "start") throw new Error("diagnostics failed");
			return { partial: () => { if (failAt === "partial") throw new Error("diagnostics failed"); }, end: () => { throw new Error("diagnostics failed"); }, error: () => {} };
		} });
		faux.setResponses([answer("unchanged"), answer("complete")]);
		const stream = wrapped.streamSimple(faux.models[0], { messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		for await (const _event of stream) { /* Consume the normal stream. */ }
		assert.equal((await stream.result()).stopReason, "stop");
		assert.equal((await wrapped.completeSimple(faux.models[0], { messages: [] })).stopReason, "stop");
	}
});

for (const mode of ["stream", "unsafe"] as const) test(`SIGKILL ${mode} trace reopens and records recovery without losing the original attempt`, { timeout: 15_000 }, async () => {
	await temporary(async (root) => {
		const child = fork(new URL("./fixtures/trace-crash.ts", import.meta.url), [root, mode], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		try {
			await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Fixture exited: ${stderr}`); })]);
			const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
			const reopened = await fixture(root, { models: createModels(), extensions: [defineExtension({ name: "test", tools: [defineTool({ name: "effect", description: "effect", parameters: Type.Object({}), replay: "unsafe", execute: async () => { throw new Error("Must not replay"); } })] })] });
			reopened.faux.setResponses([answer("recovered")]);
			try {
				await reopened.owner.harness.waitForIdle(context); reopened.trace.flush();
				const records = reopened.trace.store.list(); assert.equal(records.length, 1);
				assert.equal(records[0]!.status, "completed", JSON.stringify({ records, inspection: await reopened.owner.harness.inspect(context) }));
				assert.ok(records[0]!.spans.every((span) => span.endedAt !== undefined));
				assert.ok(records[0]!.spans.some((span) => span.attributes["loom.recovered"]));
				if (mode === "stream") assert.ok(records[0]!.spans.some((span) => span.name === "pi.ai.request" && span.attributes["loom.outcome"] === "interrupted"));
				else assert.ok(records[0]!.spans.some((span) => span.name === "pi.harness.tool" && String(span.attributes["loom.io.output"]).includes("may have partially run")));
			} finally { await reopened.close(); }
		} finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
	});
});

test("trace store persists atomic revisions, pages tied timestamps, and retains older records", async () => {
	await temporary(async (root) => {
		let store = await TraceStore.open(root);
		assert.equal(store.path, join(root, ".agents", "traces", "traces.sqlite"));
		for (let i = 0; i < 45; i++) store.save({ id: String(i).padStart(3, "0"), at: 10, threadId: "1", revision: 1, status: "completed", spans: [] });
		const page = store.list(); assert.equal(page.length, 40);
		assert.equal(store.list(40, { at: page.at(-1)!.at, id: page.at(-1)!.id }).length, 5);
		store.save({ ...page[0]!, revision: 2 });
		store.save({ ...page[0]!, revision: 1 }); store.close();
		store = await TraceStore.open(root);
		assert.equal(store.get(page[0]!.id)!.revision, 2);
		assert.equal(store.list(200).length, 45); store.close();
	});
});

test("two native runs persist model/tool spans with bounded payloads and reopen without duplicate traces", { timeout: 10_000 }, async () => {
	await temporary(async (root) => {
		const tool = defineTool({ name: "note", description: "note", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "test-private-key tool result" }] }) });
		const { owner, trace, faux, close } = await fixture(root, { models: createModels(), extensions: [defineExtension({ name: "test", tools: [tool] })] });
		try {
			const conversation = await owner.createConversation({}, context);
			faux.setResponses([answer(fauxToolCall("note", {}), { stopReason: "toolUse" }), answer("first"), answer("second")]);
			for (const content of ["hello test-private-key", "again"]) assert.equal((await (await conversation.submit({ type: "input", content }, context)).wait(context)).status, "done");
			trace.flush();
			const records = trace.store.list(); assert.equal(records.length, 2);
			assert.ok(records.every((record) => record.status === "completed" && record.spans.every((span) => span.endedAt !== undefined)));
			const first = records.find((record) => record.spans.some((span) => span.name === "pi.harness.tool"))!;
			assert.equal(first.spans.filter((span) => span.name === "pi.ai.request").length, 2);
			const toolSpan = first.spans.find((span) => span.name === "pi.harness.tool")!;
			assert.equal(toolSpan.attributes["pi.tool.name"], "note");
			assert.match(String(toolSpan.attributes["loom.io.output"]), /\[redacted\] tool result/);
			assert.ok(first.spans.find((span) => span.id === toolSpan.parentId)?.name === "pi.harness.turn");
			assert.ok(!JSON.stringify(records).includes("test-private-key"));
		} finally { await close(); }
		const store = await TraceStore.open(root); assert.equal(store.list().length, 2); store.close();
		assert.ok(!(await readFile(join(root, ".agents", "traces", "traces.sqlite"))).includes(Buffer.from("test-private-key")));
	});
});

test("requests in one run show the user message and store each long system text once", { timeout: 10_000 }, async () => {
	await temporary(async (root) => {
		const tool = defineTool({ name: "note", description: "note", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "done" }] }) });
		const { owner, trace, faux, close } = await fixture(root, { models: createModels(), extensions: [defineExtension({ name: "test", tools: [tool] })], agent: { instructions: "Always answer politely. ".repeat(500) } });
		try {
			const conversation = await owner.createConversation({}, context);
			faux.setResponses([answer(fauxToolCall("note", {}), { stopReason: "toolUse" }), answer("final")]);
			assert.equal((await (await conversation.submit({ type: "input", content: "WHERE_IS_MY_QUESTION" }, context)).wait(context)).status, "done");
			trace.flush();
			const record = trace.store.list()[0]!;
			const requests = record.spans.filter((span) => span.name === "pi.ai.request");
			assert.equal(requests.length, 2);
			for (const request of requests) assert.ok(String(request.attributes["loom.io.input"]).includes("WHERE_IS_MY_QUESTION"));
			const hashes = requests.flatMap((request) => splitTraceBlobs(String(request.attributes["loom.io.input"])).filter((part) => "hash" in part).map((part) => (part as { hash: string }).hash));
			assert.ok(hashes.length >= 2, "both requests reference the long system text");
			for (const hash of hashes) assert.ok(record.blobs?.[hash]);
			assert.equal(Object.keys(record.blobs ?? {}).length, new Set(hashes).size, "each distinct text is stored once");
		} finally { await close(); }
	});
});

test("parallel specialist runs share the parent trace and keep correct ownership", { timeout: 10_000 }, async () => {
	await temporary(async (root) => {
		const entered = Promise.withResolvers<void>(); let count = 0;
		const specialist = createSpecialistExtension("retrieve", [], { name: "permission" }, [{ name: "loom.trace" }]);
		const extension = defineExtension({ name: "parent", tools: [specialist.tool] });
		const { owner, trace, faux, close } = await fixture(root, { models: createModels(), extensions: [extension, specialist.child], settings: { extensions: [extension] } });
		try {
			const child = async () => { if (++count === 2) entered.resolve(); await entered.promise; return answer("child"); };
			faux.setResponses([answer([fauxToolCall("run_retrieve_agent", { goal: "alpha" }), fauxToolCall("run_retrieve_agent", { goal: "beta" })], { stopReason: "toolUse" }), child, child, answer("parent")]);
			const conversation = await owner.createConversation({}, context);
			assert.equal((await (await conversation.submit({ type: "input", content: "two tasks" }, context)).wait(context)).status, "done");
			trace.flush();
			const records = trace.store.list(); assert.equal(records.length, 1);
			const record = records[0]!;
			assert.equal(record.spans.filter((span) => span.name === "pi.ai.request").length, 4);
			const tools = record.spans.filter((span) => span.name === "pi.harness.tool"); assert.equal(tools.length, 2);
			for (const tool of tools) assert.equal(record.spans.filter((span) => span.name === "pi.harness.turn" && span.parentId === tool.id).length, 1);
		} finally { entered.resolve(); await close(); }
	});
});

test("nested tool calls keep a separate child span and bounded result", { timeout: 10_000 }, async () => {
	await temporary(async (root) => {
		const leaf = defineTool({ name: "leaf", description: "leaf", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "nested result" }] }) });
		const outer = defineTool({ name: "outer", description: "outer", parameters: Type.Object({}), execute: async (_args, api, context) => {
			await api.executeTool("leaf", {}, context);
			return { output: [{ type: "text", text: "outer result" }] };
		} });
		const { owner, trace, faux, close } = await fixture(root, { models: createModels(), extensions: [defineExtension({ name: "tools", tools: [leaf, outer] })] });
		try {
			faux.setResponses([answer(fauxToolCall("outer", {}), { stopReason: "toolUse" }), answer("done")]);
			const conversation = await owner.createConversation({}, context);
			assert.equal((await (await conversation.submit({ type: "input", content: "nested" }, context)).wait(context)).status, "done"); trace.flush();
			const spans = trace.store.list()[0]!.spans;
			const parent = spans.find((span) => span.attributes["pi.tool.name"] === "outer")!;
			const child = spans.find((span) => span.attributes["pi.tool.name"] === "leaf")!;
			assert.equal(child.parentId, parent.id);
			assert.match(String(child.attributes["loom.io.output"]), /nested result/);
			assert.ok(child.endedAt !== undefined);
		} finally { await close(); }
	});
});

test("deferred request and polls are separate closed spans", { timeout: 10_000 }, async () => {
	await temporary(async (root) => {
		const faux = fauxProvider({ deferred: { pendingFetches: 1, pollAfterMs: 1 } });
		const models = createModels(); models.setProvider(faux.provider);
		const trace = new DurableTrace(await TraceStore.open(root));
		const owner = await LibraryRuntime.open(root, { models: trace.models(models), resume: false, extensions: [trace.extension], settings: { stream: { deferred: true } }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
		await trace.start(owner.harness);
		try {
			faux.setResponses([answer("deferred answer")]);
			const conversation = await owner.createConversation({}, context);
			assert.equal((await (await conversation.submit({ type: "input", content: "defer" }, context)).wait(context)).status, "done"); trace.flush();
			const record = trace.store.list()[0]!;
			assert.equal(record.status, "completed");
			const requests = record.spans.filter((span) => span.name === "pi.ai.request");
			assert.equal(requests.length, 3); assert.ok(requests.every((span) => span.endedAt !== undefined));
			assert.equal(requests.filter((span) => span.attributes["pi.ai.operation"] === "poll").length, 2);
		} finally { await owner.close(context); trace.stop(); }
	});
});

test("retry attempts, manual compaction, and Stop settle persisted spans", { timeout: 10_000 }, async () => {
	await temporary(async (root) => {
		const { owner, trace, faux, close } = await fixture(root, { models: createModels(), settings: { retry: { baseDelayMs: 1 }, compaction: { keepRecentTokens: 20 } } });
		try {
			const conversation = await owner.createConversation({}, context);
			faux.setResponses([answer("", { stopReason: "error", errorMessage: "503 temporarily unavailable" }), answer("retried")]);
			assert.equal((await (await conversation.submit({ type: "input", content: "retry" }, context)).wait(context)).status, "done");
			trace.flush();
			const retried = trace.store.list()[0]!;
			assert.equal(retried.spans.filter((span) => span.name === "pi.ai.request").length, 2);
			assert.ok(retried.spans.some((span) => span.attributes["pi.step.kind"] === "retry" && span.endedAt !== undefined));
			for (let i = 0; i < 8; i++) await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test", model: [{ role: "user", content: "old context ".repeat(100), timestamp: Date.now() }] }), context);
			faux.setResponses([answer("summary")]);
			const task = await conversation.compact(undefined, context);
			assert.equal((await owner.harness.waitForTask(task, context)).state.outcome.status, "completed"); trace.flush();
			const compacted = trace.store.list().find((record) => record.id === `compaction:${task}`)!;
			assert.ok(compacted);
			assert.ok(compacted.spans.some((span) => span.name === "pi.ai.request" && span.endedAt !== undefined));
			const entered = Promise.withResolvers<void>();
			faux.setResponses([async (_request, options) => {
				entered.resolve();
				await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
				return answer("", { stopReason: "aborted" });
			}]);
			const running = await conversation.submit({ type: "input", content: "stop" }, context);
			await entered.promise; await conversation.abort(context);
			assert.equal((await running.wait(context)).status, "unanswered"); trace.flush();
			const aborted = trace.store.get(`run:${running.id}`)!;
			assert.equal(aborted.status, "aborted");
			assert.ok(aborted.spans.every((span) => span.endedAt !== undefined));
		} finally { await close(); }
	});
});

test("approval wait survives owner reopen in the same persisted trace, then rejection settles spans", { timeout: 10_000 }, async () => {
	await temporary(async (root) => {
		const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
		let owner: LibraryRuntime; let trace: DurableTrace; let gate = new ToolGate(); gate.level = "basic";
		const open = async () => {
			trace = new DurableTrace(await TraceStore.open(root));
			const permission = gate.extension(root, () => owner.harness);
			const tool = defineTool({ name: "write", description: "write", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "saved" }] }) });
			const extension = defineExtension({ name: "test", tools: [tool] });
			owner = await LibraryRuntime.open(root, { models: trace.models(models), resume: false, extensions: [extension, permission, trace.extension], agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } }, conversationCreated: async (tx, record) => { await tx.doc(LoomApprovalsDoc, record.id); } }, context);
			await trace.start(owner.harness);
		};
		await open();
		try {
			faux.setResponses([answer(fauxToolCall("write", {}), { stopReason: "toolUse" }), answer("done")]);
			const conversation = await owner!.createConversation({}, context);
			const submission = await conversation.submit({ type: "input", content: "write", requestId: "recovery" }, context);
			const pending = async () => {
				for (let i = 0; i < 100; i++) { const row = (await owner!.harness.snapshot(LoomApprovalsDoc, conversation.id, context))?.pending[0]; if (row) return row.toolCallId; await new Promise((resolve) => setTimeout(resolve, 10)); }
				throw new Error("No approval");
			};
			await pending(); trace!.flush();
			assert.equal(trace!.store.list()[0]!.status, "running");
			await owner!.close(context); trace!.stop();
			gate = new ToolGate(); gate.level = "basic"; await open();
			await clearPendingApprovals(owner!.harness); owner!.harness.resume();
			gate.resolve(await pending(), "reject");
			const handle = await owner!.harness.submission(submission.id, context);
			assert.equal((await handle!.wait(context)).status, "done"); trace!.flush();
			const records = trace!.store.list(); assert.equal(records.length, 1); assert.equal(records[0]!.status, "completed");
			assert.ok(records[0]!.spans.some((span) => span.attributes["loom.recovered"]));
			assert.ok(records[0]!.spans.filter((span) => span.name === "loom.approval").every((span) => span.endedAt !== undefined));
		} finally { await owner!.close(context); trace!.stop(); }
	});
});
