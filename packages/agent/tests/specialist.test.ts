import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context, createModels, createSpecialistExtension, defineExtension, defineTool,
	LibraryAgent, listLoomConversations, LoomApprovalsDoc, clearPendingApprovals, ToolGate, ToolResultEntry,
} from "../src/durable.ts";
import { partitionLibraryTools, specialistUserMessage, RETRIEVE_SYSTEM_PROMPT } from "../src/specialist.ts";

const call = (name: string, args = {}) => answer(fauxToolCall(name, args), { stopReason: "toolUse" });

test("specialists partition search and MCP off the parent and accept only a self-contained task", () => {
	const split = partitionLibraryTools(["search_assets", "inspect_asset", "describe_image", "comfy__generate", "run_retrieve_agent"].map((name) => ({ name, description: name, parameters: Type.Object({}), execute: () => name })));
	assert.deepEqual(split.parent.map((tool) => tool.name), ["describe_image"]);
	assert.deepEqual(split.retrieve.map((tool) => tool.name), ["search_assets", "inspect_asset"]);
	assert.deepEqual(split.create.map((tool) => tool.name), ["comfy__generate"]);
	assert.equal(specialistUserMessage(" find the dock "), "Task:\nfind the dock");
	assert.match(RETRIEVE_SYSTEM_PROMPT, /asset_id.*inspect_asset.*exact id first; do not call search_assets/);
	assert.match(RETRIEVE_SYSTEM_PROMPT, /read on the relativePath returned by inspect_asset/);
});

for (const action of ["approve", "reject", "stop", "reopen"] as const) {
	test(`owned specialist ${action}: isolation, busy parent, approval and durable ownership`, { timeout: 10_000 }, async () => {
		const path = await mkdtemp(join(tmpdir(), "loom-specialist-"));
		const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
		let owner: LibraryAgent | undefined;
		let gate = new ToolGate(); gate.level = "basic";
		let writes = 0;
		const open = async () => {
			const permission = gate.extension(path, () => owner!.harness);
			const specialist = createSpecialistExtension("create", [defineTool({ name: "write", description: "write", parameters: Type.Object({}), replay: "unsafe", execute: async () => { writes++; return { output: [{ type: "text", text: "saved" }] }; } })], permission);
			const parentExtension = defineExtension({ name: "parent", tools: [specialist.tool] });
			return LibraryAgent.open(path, {
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
					assert.match(JSON.stringify(request), /"name":"write"/);
					assert.doesNotMatch(JSON.stringify(request), /run_create_agent/);
					assert.match(JSON.stringify(request.messages), /Task:\\nplace the result/);
					assert.doesNotMatch(JSON.stringify(request.messages), /parent-secret/);
					return call("write");
				}, answer("child-summary"), answer("parent-answer"),
			]);
			const parent = await owner.createConversation({}, context);
			const submission = await parent.submit({ type: "input", content: "parent-secret", requestId: "parent-request" }, context);
			const approval = Promise.withResolvers<{ id: string; child: number }>();
			const unsubscribe = owner.harness.subscribeCommits((publication) => {
				for (const change of publication.changes) if (change.type === "document" && change.record.kind === "loom.approvals" && change.record.scope.kind === "conversation") {
					const child = change.record.scope.conversationId;
					void owner!.harness.snapshot(LoomApprovalsDoc, child, context).then((doc) => {
						if (doc?.pending[0]) approval.resolve({ id: doc.pending[0].toolCallId, child });
					});
				}
			});
			const pending = await approval.promise;
			const childId = pending.child as typeof parent.id;
			assert.equal((await listLoomConversations(owner.harness, {}, context)).length, 1);
			assert.equal((await listLoomConversations(owner.harness, { includeOwned: true }, context)).length, 2);
			await assert.rejects(parent.submit({ type: "input", content: "busy", whenBusy: "reject" }, context), /busy/i);
			if (action === "stop") await parent.abort(context);
			else if (action === "reopen") {
				unsubscribe(); await owner.close(context);
				gate = new ToolGate(); gate.level = "basic";
				owner = await open();
				await clearPendingApprovals(owner.harness);
				assert.deepEqual((await owner.harness.snapshot(LoomApprovalsDoc, childId, context))?.pending, []);
				const reapproval = Promise.withResolvers<string>();
				const watch = await owner.harness.watchDoc(LoomApprovalsDoc, childId, context);
				watch!.start(async (doc) => { if (doc?.pending[0]) reapproval.resolve(doc.pending[0].toolCallId); });
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
			assert.ok(!entries.some((entry) => ToolResultEntry.is(entry) && entry.model?.some((message) => message.role === "toolResult" && message.toolName === "write")));
			unsubscribe();
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
	const owner = await LibraryAgent.open(path, { models, extensions: [parent, specialist.child], settings: { extensions: [parent] }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
	try {
		faux.setResponses([answer([fauxToolCall("run_retrieve_agent", { goal: "alpha" }), fauxToolCall("run_retrieve_agent", { goal: "beta" })], { stopReason: "toolUse" }), childResponse, childResponse, answer("both found")]);
		const conversation = await owner.createConversation({}, context);
		assert.equal((await (await conversation.submit({ type: "input", content: "two tasks" }, context)).wait(context)).status, "done");
		assert.equal(maxRunning, 2);
		assert.equal((await listLoomConversations(owner.harness, { includeOwned: true }, context)).length, 3);
	} finally { await owner.close(context); await rm(path, { recursive: true, force: true }); }
});
