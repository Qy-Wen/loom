import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context, createModels, defineExtension, LibraryRuntime,
	LoomApprovalsDoc, ToolGate, toDurableTool,
} from "../src/durable.ts";

for (const level of ["basic", "standard"] as const) {
	for (const action of ["approve", "reject", "stop", "remember"] as const) {
		test(`main MCP ${level} ${action}: approval precedes external execution`, { timeout: 10_000 }, async () => {
			const path = await mkdtemp(join(tmpdir(), "loom-mcp-gate-"));
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const gate = new ToolGate();
			gate.level = level;
			const calls: unknown[] = [];
			let owner: LibraryRuntime | undefined;
			try {
				const permission = gate.extension(path, () => owner!.harness);
				const tools = defineExtension({ name: "test.publish", tools: [toDurableTool({
					name: "social__publish", description: "Publish media",
					parameters: Type.Object({ file: Type.String(), title: Type.String() }),
					execute: (args) => { calls.push(args); return "published"; },
				})] });
				owner = await LibraryRuntime.open(path, {
					models, resume: false, extensions: [tools, permission],
					settings: { extensions: [tools, permission] },
					agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } },
					conversationCreated: async (tx, record) => { await tx.doc(LoomApprovalsDoc, record.id); },
				}, context);
				const conversation = await owner.createConversation({}, context);
				const pending = Promise.withResolvers<string>();
				const watch = await owner.harness.watchDoc(LoomApprovalsDoc, conversation.id, context);
				watch!.start(async (call) => { if (call.kind === "failed") throw call.error; const doc = call.value; if (doc?.pending[0]) pending.resolve(doc.pending[0].toolCallId); });
				const args = { file: "media/first.mp4", title: "First post" };
				faux.setResponses([
					answer(fauxToolCall("social__publish", args), { stopReason: "toolUse" }), answer("Done"),
				]);
				owner.harness.resume();
				const submission = await conversation.submit({ type: "input", content: "Publish my video", requestId: "first" }, context);
				const id = await pending.promise;
				assert.deepEqual(calls, []);
				assert.deepEqual((await owner.harness.snapshot(LoomApprovalsDoc, conversation.id, context))?.pending[0]?.args, args);
				if (action === "stop") await conversation.abort(context);
				else {
					if (action === "remember") gate.allows = [gate.pendingCommandAllow(id, path)!];
					assert.equal(gate.resolve(id, action === "reject" ? "reject" : "approve"), true);
				}
				await submission.wait(context);
				assert.deepEqual(calls, action === "approve" || action === "remember" ? [args] : []);
				assert.deepEqual((await owner.harness.snapshot(LoomApprovalsDoc, conversation.id, context))?.pending, []);
				await watch!.stop();
				if (action === "remember") {
					const nextArgs = { file: "media/second.mp4", title: "Second post" };
					faux.setResponses([
						answer(fauxToolCall("social__publish", nextArgs), { stopReason: "toolUse" }), answer("Done again"),
					]);
					const next = await conversation.submit({ type: "input", content: "Publish another video", requestId: "second" }, context);
					await next.wait(context);
					assert.deepEqual(calls, [args, nextArgs]);
				}
			} finally { await owner?.close(context); await rm(path, { recursive: true, force: true }); }
		});
	}
}
