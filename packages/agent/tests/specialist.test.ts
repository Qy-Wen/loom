import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context, createModels, createSpecialistExtension, defineExtension, defineTool,
	LibraryRuntime, listLoomConversations, LoomApprovalsDoc, clearPendingApprovals, ToolGate, ToolResultEntry, toDurableTool,
} from "../src/durable.ts";
import { partitionLibraryTools, specialistDescription, specialistUserMessage, RETRIEVE_SYSTEM_PROMPT } from "../src/extensions/specialist.ts";

const call = (name: string, args = {}) => answer(fauxToolCall(name, args), { stopReason: "toolUse" });

test("parent shares retrieval and MCP tools with the corresponding specialists", () => {
	const split = partitionLibraryTools(["search_assets", "deep_search_assets", "inspect_asset", "describe_image", "comfy__generate", "run_retrieve_agent"].map((name) => ({ name, description: name, parameters: Type.Object({}), execute: () => name })));
	assert.deepEqual(split.parent.map((tool) => tool.name), ["search_assets", "deep_search_assets", "inspect_asset", "describe_image", "comfy__generate"]);
	assert.deepEqual(split.retrieve.map((tool) => tool.name), ["search_assets", "deep_search_assets", "inspect_asset"]);
	assert.deepEqual(split.create.map((tool) => tool.name), ["inspect_asset", "comfy__generate"]);
	assert.equal(specialistUserMessage(" find the dock "), "Task:\nfind the dock");
	assert.match(RETRIEVE_SYSTEM_PROMPT, /asset_id.*inspect_asset.*exact id first; do not call search_assets/);
	assert.match(RETRIEVE_SYSTEM_PROMPT, /read on the relativePath returned by inspect_asset/);
	assert.match(RETRIEVE_SYSTEM_PROMPT, /deep_search_assets/);
	assert.match(RETRIEVE_SYSTEM_PROMPT, /indexedCount/);
	assert.match(RETRIEVE_SYSTEM_PROMPT, /Search does not follow relations/);
	assert.doesNotMatch(RETRIEVE_SYSTEM_PROMPT, /linkedFrom/);
	assert.match(specialistDescription("retrieve"), /only when there are multiple independent retrieval tasks that can run in parallel/);
	assert.match(specialistDescription("retrieve"), /Handle a single retrieval task, including a multi-step one, directly/);
});

test("create receives inspect and FFmpeg tools without search or settings", () => {
	const names = ["search_assets", "deep_search_assets", "inspect_asset", "grade_image", "run_ffmpeg", "run_ffprobe", "describe_image", "update_settings", "comfy__generate"];
	const split = partitionLibraryTools(names.map((name) => ({ name, description: name, parameters: Type.Object({}), execute: () => name })));
	assert.deepEqual(split.create.map((tool) => tool.name), ["inspect_asset", "grade_image", "run_ffmpeg", "run_ffprobe", "comfy__generate"]);
	assert.deepEqual(split.retrieve.map((tool) => tool.name), ["search_assets", "deep_search_assets", "inspect_asset"]);
	assert.deepEqual(split.parent.map((tool) => tool.name), names);
});

test("parent and create share the same MCP tools while retrieve stays isolated", () => {
	const tools = ["publish__video", "comfy__generate", "social__login"].map((name) => ({ name, description: name, parameters: Type.Object({}), execute: () => name }));
	const split = partitionLibraryTools(tools);
	assert.deepEqual(split.parent, tools);
	assert.deepEqual(split.create, tools);
	for (const [index, tool] of tools.entries()) {
		assert.equal(split.parent[index], tool);
		assert.equal(split.create[index], tool);
	}
	assert.deepEqual(split.retrieve, []);
});

test("parent can call an MCP tool directly and delegate a separate task using the same tool", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-shared-mcp-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const gate = new ToolGate();
	gate.level = "full";
	const briefs: string[] = [];
	const grouped = partitionLibraryTools([{
		name: "comfy__generate", description: "Generate an image", parameters: Type.Object({ brief: Type.String() }),
		execute: (args) => { const { brief } = args as { brief: string }; briefs.push(brief); return `images/${brief}.png`; },
	}]);
	let owner: LibraryRuntime | undefined;
	try {
		const permission = gate.extension(path, () => owner!.harness);
		const specialist = createSpecialistExtension("create", grouped.create.map(toDurableTool), permission);
		const parent = defineExtension({ name: "test.parent", tools: [...grouped.parent.map(toDurableTool), specialist.tool] });
		owner = await LibraryRuntime.open(path, {
			models, resume: false, extensions: [parent, specialist.child, permission],
			settings: { extensions: [parent, permission] },
			agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } },
		}, context);
		faux.setResponses([
			(request) => {
				assert.match(JSON.stringify(request), /"name":"comfy__generate"/);
				assert.match(JSON.stringify(request), /"name":"run_create_agent"/);
				return call("comfy__generate", { brief: "direct" });
			},
			call("run_create_agent", { goal: "Generate a separate image with brief delegated" }),
			(request) => {
				assert.match(JSON.stringify(request), /"name":"comfy__generate"/);
				assert.doesNotMatch(JSON.stringify(request), /run_create_agent/);
				return call("comfy__generate", { brief: "delegated" });
			},
			answer("images/delegated.png"), answer("Both images are ready"),
		]);
		owner.harness.resume();
		const conversation = await owner.createConversation({}, context);
		const submission = await conversation.submit({ type: "input", content: "Generate two different images", requestId: "shared-mcp" }, context);
		assert.equal((await submission.wait(context)).status, "done");
		assert.deepEqual(briefs, ["direct", "delegated"]);
		assert.equal((await listLoomConversations(owner.harness, { includeOwned: true }, context)).length, 2);
	} finally { await owner?.close(context); await rm(path, { recursive: true, force: true }); }
});

for (const toolName of ["write", "comfy__generate"]) for (const action of ["approve", "reject", "stop", "reopen"] as const) {
	test(`owned specialist ${toolName} ${action}: isolation, busy parent, approval and durable ownership`, { timeout: 10_000 }, async () => {
		const path = await mkdtemp(join(tmpdir(), "loom-specialist-"));
		const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
		let owner: LibraryRuntime | undefined;
		let gate = new ToolGate(); gate.level = toolName === "write" ? "basic" : "standard";
		let writes = 0;
		const open = async () => {
			const permission = gate.extension(path, () => owner!.harness);
			const specialist = createSpecialistExtension("create", [defineTool({ name: toolName, description: toolName, parameters: Type.Object({}), replay: "unsafe", execute: async () => { writes++; return { output: [{ type: "text", text: "saved" }] }; } })], permission);
			const parentExtension = defineExtension({ name: "parent", tools: [specialist.tool] });
			return LibraryRuntime.open(path, {
				models, resume: false, extensions: [specialist.child, permission, parentExtension],
				settings: { extensions: [parentExtension, permission] },
				agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } },
				conversationCreated: async (tx, record) => { await tx.doc(LoomApprovalsDoc, record.id); },
			}, context);
		};
		try {
			owner = await open(); owner.harness.resume();
			faux.setResponses([
				call("run_create_agent", { goal: "place the result" }),
				(request) => {
					assert.ok(JSON.stringify(request).includes(`"name":"${toolName}"`));
					assert.doesNotMatch(JSON.stringify(request), /run_create_agent/);
					assert.match(JSON.stringify(request.messages), /Task:\\nplace the result/);
					assert.doesNotMatch(JSON.stringify(request.messages), /parent-secret/);
					return call(toolName);
				}, answer("child-summary"), answer("parent-answer"),
			]);
			const parent = await owner.createConversation({}, context);
			const submission = await parent.submit({ type: "input", content: "parent-secret", requestId: "parent-request" }, context);
			const approval = Promise.withResolvers<{ id: string; child: number }>();
			const unsubscribe = owner.harness.observeCommits({ advance: (publication) => {
				for (const change of publication.changes) if (change.type === "document" && change.record.kind === "loom.approvals" && change.record.scope.kind === "conversation") {
					const child = change.record.scope.conversationId;
					void owner!.harness.snapshot(LoomApprovalsDoc, child, context).then((doc) => {
						if (doc?.pending[0]) approval.resolve({ id: doc.pending[0].toolCallId, child });
					});
				}
			}, end: () => {} });
			const pending = await approval.promise;
			const childId = pending.child as typeof parent.id;
			assert.equal((await listLoomConversations(owner.harness, {}, context)).length, 1);
			assert.equal((await listLoomConversations(owner.harness, { includeOwned: true }, context)).length, 2);
			await assert.rejects(parent.submit({ type: "input", content: "busy", whenBusy: "reject" }, context), /busy/i);
			if (action === "stop") await parent.abort(context);
			else if (action === "reopen") {
				unsubscribe.detach(); await owner.close(context);
				gate = new ToolGate(); gate.level = toolName === "write" ? "basic" : "standard";
				owner = await open();
				await clearPendingApprovals(owner.harness);
				assert.deepEqual((await owner.harness.snapshot(LoomApprovalsDoc, childId, context))?.pending, []);
				const reapproval = Promise.withResolvers<string>();
				const watch = await owner.harness.watchDoc(LoomApprovalsDoc, childId, context);
				watch!.start(async (call) => { if (call.kind === "failed") throw call.error; const doc = call.value; if (doc?.pending[0]) reapproval.resolve(doc.pending[0].toolCallId); });
				owner.harness.resume();
				gate.resolve(await reapproval.promise, "reject");
				await watch!.stop();
			} else gate.resolve(pending.id, action);
			const resumed = await owner.harness.conversation(parent.id, context);
			const handle = await resumed!.submit({ type: "input", content: "parent-secret", requestId: "parent-request" }, context);
			await handle.wait(context);
			if (action !== "reopen") assert.equal((await submission.wait(context)).status, action === "stop" ? "unanswered" : "done");
			assert.equal(writes, action === "approve" ? 1 : 0);
			assert.deepEqual((await owner.harness.snapshot(LoomApprovalsDoc, childId, context))?.pending, []);
			const entries = (await resumed!.context(context)).entries;
			assert.ok(!entries.some((entry) => ToolResultEntry.is(entry) && entry.model?.some((message) => message.role === "toolResult" && message.toolName === toolName)));
			unsubscribe.detach();
		} finally { await owner?.close(context); await rm(path, { recursive: true, force: true }); }
	});
}

test("independent retrieve calls run concurrently with separate owned histories", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-specialist-parallel-"));
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const entered = Promise.withResolvers<void>();
	let running = 0; let maxRunning = 0;
	const childResponse = async () => {
		running++; maxRunning = Math.max(maxRunning, running);
		if (running === 2) entered.resolve();
		await entered.promise;
		running--; return answer("child-summary");
	};
	const specialist = createSpecialistExtension("retrieve", [], { name: "permission" });
	const parent = defineExtension({ name: "parent", tools: [specialist.tool] });
	const owner = await LibraryRuntime.open(path, { models, extensions: [parent, specialist.child], settings: { extensions: [parent] }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
	try {
		faux.setResponses([answer([fauxToolCall("run_retrieve_agent", { goal: "alpha" }), fauxToolCall("run_retrieve_agent", { goal: "beta" })], { stopReason: "toolUse" }), childResponse, childResponse, answer("both found")]);
		const conversation = await owner.createConversation({}, context);
		assert.equal((await (await conversation.submit({ type: "input", content: "two tasks" }, context)).wait(context)).status, "done");
		assert.equal(maxRunning, 2);
		assert.equal((await listLoomConversations(owner.harness, { includeOwned: true }, context)).length, 3);
	} finally { await owner.close(context); await rm(path, { recursive: true, force: true }); }
});
