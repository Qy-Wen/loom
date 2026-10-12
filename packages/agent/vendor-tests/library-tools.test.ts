import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context,
	createLibraryExtension,
	createWorkspaceTools,
	LibraryAgent,
	LoomMemoryDoc,
	ToolResultEntry,
	toDurableTool,
	type Conversation,
	type JsonObject,
	type ToolExecutionApi,
	withAbortSignal,
} from "@loom/agent/durable";
import { libraryAutoMemoryFile, updateLibraryAutoMemory } from "../src/library-auto-memory.ts";
import { releaseProcessSandbox, setProcessSandboxRoot } from "@loom/core/sandbox";

async function temporary(run: (path: string) => Promise<void>) {
	const path = await mkdtemp(join(tmpdir(), "loom-library-tools-"));
	try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function setup(path: string, extra: Parameters<typeof createLibraryExtension>[1] = {}) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const assembly = await createLibraryExtension(path, extra);
	const owner = await LibraryAgent.open(path, {
		models,
		extensions: [assembly.extension],
		conversationCreated: assembly.conversationCreated,
		agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id }, instructions: "user instructions" },
	}, context);
	return { owner, faux };
}

async function run(conversation: Conversation, faux: ReturnType<typeof fauxProvider>, responses: FauxResponseStep[]) {
	faux.setResponses([...responses, fauxAssistantMessage("finished")]);
	assert.equal((await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context)).status, "done");
	return (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items
		.filter((entry) => ToolResultEntry.is(entry))
		.map((entry) => entry.model![0]!)
		.filter((message) => message.role === "toolResult");
}

const text = (content: Array<{ type: string; text?: string }>) => content.map((part) => part.text ?? "").join("\n");

test("durable coding tools follow per-conversation cwd, with sandbox prepare and edit", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const next = join(path, "next");
		await mkdir(next);
		await writeFile(join(next, "note.txt"), "other cwd");
		let prepared = false;
		const { owner, faux } = await setup(path, { workspace: { prepareBash: (execution, api, ctx) => {
			assert.equal(execution.cwd, owner.libraryPath);
			assert.equal(api.env?.cwd, owner.libraryPath);
			assert.equal(ctx.abortSignal?.aborted, false);
			assert.equal(execution.inheritEnv, true);
			prepared = true;
			execution.command = "printf 'prepared command'";
		} } });
		try {
			const conversation = await owner.createConversation({}, context);
			const results = await run(conversation, faux, [
				call("write", { path: "note.txt", content: "hello" }),
				call("edit", { path: "note.txt", edits: [{ oldText: "hello", newText: "updated" }] }),
				call("read", { path: "note.txt" }),
				call("bash", { command: "ignored", timeout: 5 }),
			]);
			assert.ok(results.every((result) => !result.isError), JSON.stringify(results));
			assert.equal(await readFile(join(path, "note.txt"), "utf8"), "updated");
			assert.match(text(results[2]!.content), /updated/);
			assert.match(text(results[3]!.content), /prepared command/);
			assert.equal(prepared, true);
			await conversation.configure({ cwd: next }, context);
			const changed = await run(conversation, faux, [call("read", { path: "note.txt" })]);
			assert.match(text(changed.at(-1)!.content), /other cwd/);
		} finally { await owner.close(context); }
	});
});

test("upstream Photon read returns image content and does not require Loom image code", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		await writeFile(join(path, "pixel.gif"), Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
		const { owner, faux } = await setup(path);
		try {
			const conversation = await owner.createConversation({}, context);
			const results = await run(conversation, faux, [call("read", { path: "pixel.gif" })]);
			assert.equal(results[0]?.isError, false);
			assert.equal(results[0]?.content[0]?.type, "image");
		} finally { await owner.close(context); }
	});
});

test("adapted Loom tools forward args and cancellation, preserve mixed output and JSON details", async () => {
	const controller = new AbortController();
	const tool = toDurableTool({
		name: "preview", description: "Preview", parameters: Type.Object({ id: Type.String() }),
		execute: (args, signal) => {
			assert.deepEqual(args, { id: "asset" });
			assert.equal(signal, controller.signal);
			return { content: [{ type: "text", text: "preview" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], details: { id: "asset" } };
		},
	});
	assert.equal(tool.replay, "unsafe");
	const result = await tool.execute({ id: "asset" }, {} as ToolExecutionApi, withAbortSignal(controller.signal, context));
	assert.deepEqual(result.details, { id: "asset" });
	assert.equal(result.output?.[1]?.type, "image");
	controller.abort();
	await assert.rejects(tool.execute({ id: "asset" }, {} as ToolExecutionApi, withAbortSignal(controller.signal, context)));
	const optional = toDurableTool({ name: "optional", description: "Optional fields", parameters: Type.Object({}), execute: () => ({ content: "text", details: { width: 64, audioCodec: undefined, nested: { absent: undefined, present: null } } }) });
	assert.deepEqual((await optional.execute({}, {} as ToolExecutionApi, context)).details, { width: 64, nested: { present: null } });
	const invalidArray = toDurableTool({ name: "array", description: "Invalid array", parameters: Type.Object({}), execute: () => ({ content: "text", details: [undefined] }) });
	await assert.rejects(invalidArray.execute({}, {} as ToolExecutionApi, context), /strict JSON/);
	const invalid = toDurableTool({ name: "invalid", description: "Invalid", parameters: Type.Object({}), execute: () => ({ content: "text", details: new Date() }) });
	await assert.rejects(invalid.execute({}, {} as ToolExecutionApi, context), /strict JSON/);
});

test("library extension persists memory changes but keeps the conversation prompt frozen across fork/reopen", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		await updateLibraryAutoMemory(path, { action: "add", content: "original fact" });
		const { owner, faux } = await setup(path, { systemPrompt: "Base prompt" });
		try {
			const conversation = await owner.createConversation({}, context);
			const results = await run(conversation, faux, [
				call("auto_memory", { action: "add", content: "new fact" }),
				call("auto_memory", { action: "replace", old_text: "new fact", content: "changed fact" }),
			]);
			assert.ok(results.every((result) => !result.isError));
			assert.match(await readFile(libraryAutoMemoryFile(path), "utf8"), /changed fact/);
			const snapshot = await owner.harness.snapshot(LoomMemoryDoc, conversation.id, context);
			assert.equal(snapshot?.snapshot, "original fact");
			const messages = (await conversation.context(context)).messages;
			const system = messages.find((message) => message.role === "system");
			assert.ok(system?.role === "system");
			assert.equal(system.sections?.preamble, "Base prompt");
			assert.match(system.sections?.auto_memory ?? "", /original fact/);
			assert.doesNotMatch(system.sections?.auto_memory ?? "", /changed fact/);
			assert.equal(system.sections?.instructions, "<instructions>\nuser instructions\n</instructions>");
			const entry = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items.at(-1)!;
			const fork = await conversation.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
			assert.equal((await owner.harness.snapshot(LoomMemoryDoc, fork.id, context))?.snapshot, "original fact");
			const fresh = await owner.createConversation({}, context);
			assert.match((await owner.harness.snapshot(LoomMemoryDoc, fresh.id, context))?.snapshot ?? "", /changed fact/);
			await owner.close(context);
			const reopened = await setup(path);
			try {
				assert.deepEqual(await reopened.owner.harness.snapshot(LoomMemoryDoc, conversation.id, context), snapshot);
			} finally { await reopened.owner.close(context); }
		} finally { await owner.close(context); }
	});
});

test("library extension includes Loom tools with durable output/details and rejects duplicate names", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const { owner, faux } = await setup(path, { autoMemory: false, tools: [{
			name: "library_note", description: "Get a note", parameters: Type.Object({}),
			execute: () => ({ content: "a note", details: { assetId: "asset", optional: undefined, nested: { present: null, absent: undefined } } }),
		}] });
		try {
			const conversation = await owner.createConversation({}, context);
			const results = await run(conversation, faux, [call("library_note", {})]);
			assert.equal(results[0]?.isError, false);
			assert.match(text(results[0]!.content), /a note/);
			assert.deepEqual(results[0]?.details, { assetId: "asset", nested: { present: null } });
		} finally { await owner.close(context); }
		await assert.rejects(createLibraryExtension(path, { tools: [{ name: "read", description: "duplicate", parameters: Type.Object({}), execute: () => "" }] }), /Duplicate library tool/);
	});
});

test("auto-memory can be omitted and aborted writes do not mutate disk", async () => {
	await temporary(async (path) => {
		const assembly = await createLibraryExtension(path, { autoMemory: false, workspace: { images: false } });
		assert.equal(assembly.extension.tools?.some((tool) => tool.name === "auto_memory"), false);
		assert.equal(assembly.extension.sections?.some((part) => part.key === "auto_memory"), false);
		await assert.rejects(updateLibraryAutoMemory(path, { action: "add", content: "never save" }, AbortSignal.abort()));
		await assert.rejects(readFile(libraryAutoMemoryFile(path)), { code: "ENOENT" });
	});
});

test("default durable bash fails closed without a sandbox library root", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		setProcessSandboxRoot(path);
		await releaseProcessSandbox(path);
		const { owner, faux } = await setup(path);
		try {
			const conversation = await owner.createConversation({}, context);
			const results = await run(conversation, faux, [call("bash", { command: "printf 'must not run'" })]);
			assert.equal(results[0]?.isError, true);
			assert.match(text(results[0]!.content), /no library is open/);
		} finally { await owner.close(context); }
	});
});

test("durable bash's default prepare keeps writes in-library and blocks network", { timeout: 20_000 }, async () => {
	await temporary(async (path) => {
		const outside = join(homedir(), `.loom-durable-sandbox-${Date.now()}`);
		setProcessSandboxRoot(path);
		const { owner, faux } = await setup(path);
		try {
			const conversation = await owner.createConversation({}, context);
			const results = await run(conversation, faux, [call("bash", { command: [
				"printf ok > inside.txt",
				`if printf forbidden > '${outside.replaceAll("'", "'\\''")}'; then echo OUTSIDE_OK; else echo OUTSIDE_BLOCKED; fi`,
				"if curl -sS -o /dev/null --max-time 3 https://example.com; then echo NET_OK; else echo NET_BLOCKED; fi",
			].join("\n"), timeout: 10 })]);
			assert.equal(results[0]?.isError, false, JSON.stringify(results));
			assert.match(text(results[0]!.content), /OUTSIDE_BLOCKED/);
			assert.match(text(results[0]!.content), /NET_BLOCKED/);
			assert.equal(await readFile(join(path, "inside.txt"), "utf8"), "ok");
			await assert.rejects(readFile(outside), { code: "ENOENT" });
		} finally {
			await owner.close(context);
			await releaseProcessSandbox(path);
			await rm(outside, { force: true });
		}
	});
});

test("workspace tools no longer expose mutable cwd or a legacy tool context", async () => {
	const tools = await createWorkspaceTools({ images: false });
	assert.deepEqual(tools.map((tool) => tool.name), ["read", "bash", "edit", "write"]);
	assert.equal("toolContext" in tools, false);
	assert.equal("setCwd" in tools, false);
});
