import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
	BACKGROUND_CONTEXT as context, createModels, LibraryRuntime, ToolGate, LoomApprovalsDoc,
	clearPendingApprovals, defineExtension, defineTool,
} from "@loom/agent/durable";

for (const action of ["approve", "reject", "abort"] as const) {
	test(`durable permission document waits and ${action} settles safely`, { timeout: 10_000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), "loom-tool-gate-"));
		const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
		const gate = new ToolGate(); gate.level = "basic";
		let calls = 0;
		let owner: LibraryRuntime;
		try {
			owner = await LibraryRuntime.open(directory, {
				models, extensions: [gate.extension(directory, () => owner.harness), defineExtension({ name: "writes", tools: [defineTool({
					name: "write", description: "write", parameters: Type.Object({}), execute: async () => { calls++; return { output: [{ type: "text", text: "saved" }] }; },
				})] })], agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } },
				conversationCreated: async (tx, record) => { await tx.doc(LoomApprovalsDoc, record.id); },
			}, context);
			const conversation = await owner.createConversation({}, context);
			const changed = Promise.withResolvers<string>();
			const watch = await owner.harness.watchDoc(LoomApprovalsDoc, conversation.id, context);
			watch!.start(async (value) => { if (value?.pending[0]) changed.resolve(value.pending[0].toolCallId); });
			faux.setResponses([fauxAssistantMessage(fauxToolCall("write", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
			const submission = await conversation.submit({ type: "input", content: "write" }, context);
			const id = await changed.promise;
			assert.equal(calls, 0);
			if (action === "abort") await conversation.abort(context);
			else assert.equal(gate.resolve(id, action), true);
			const settled = await submission.wait(context);
			assert.equal(settled.status, action === "abort" ? "unanswered" : "done");
			assert.equal(calls, action === "approve" ? 1 : 0);
			assert.deepEqual((await owner.harness.snapshot(LoomApprovalsDoc, conversation.id, context))?.pending, []);
			await watch!.stop(); await clearPendingApprovals(owner.harness); await owner.close(context);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}
