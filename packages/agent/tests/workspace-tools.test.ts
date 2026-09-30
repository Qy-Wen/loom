import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, type AgentHarnessToolInvocation, type JsonValue, withAbortSignal } from "#vendor/pi-agent";
import { Type } from "@earendil-works/pi-ai";
import { createWorkspaceTools, toHarnessTool } from "../src/pi-tools.ts";

const memos = new Map<string, JsonValue>();
const invocation: AgentHarnessToolInvocation = {
	invocationId: "test-invocation",
	operationId: "test-operation",
	turnId: "test-turn",
	getMemo: async (name) => memos.get(name),
	setMemo: async (name, value) => {
		if (value === undefined) memos.delete(name);
		else memos.set(name, value);
	},
};

test("native workspace tools read and write relative to cwd", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-workspace-tools-"));
	const nextRoot = await mkdtemp(join(tmpdir(), "loom-workspace-next-"));
	const outside = `${root}-outside.txt`;
	try {
		await writeFile(join(root, "note.txt"), "hello");
		await writeFile(join(nextRoot, "note.txt"), "next library");
		const workspace = createWorkspaceTools(root);
		assert.deepEqual(workspace.tools.map((tool) => tool.name), ["read", "bash", "edit", "write"]);
		const read = workspace.tools.find((tool) => tool.name === "read");
		const write = workspace.tools.find((tool) => tool.name === "write");
		assert.ok(read && write);

		const shown = await read.execute("read-1", { path: "note.txt" }, () => {}, workspace.toolContext, invocation, BACKGROUND_CONTEXT);
		assert.match(shown.content[0]?.type === "text" ? shown.content[0].text : "", /hello/);

		await write.execute("write-1", { path: "out.txt", content: "from agent" }, () => {}, workspace.toolContext, invocation, BACKGROUND_CONTEXT);
		assert.equal(await readFile(join(root, "out.txt"), "utf8"), "from agent");

		await write.execute("write-2", { path: outside, content: "escaped" }, () => {}, workspace.toolContext, invocation, BACKGROUND_CONTEXT);
		assert.equal(await readFile(outside, "utf8"), "escaped");

		workspace.setCwd(nextRoot);
		const moved = await read.execute("read-2", { path: "note.txt" }, () => {}, workspace.toolContext, invocation, BACKGROUND_CONTEXT);
		assert.match(moved.content[0]?.type === "text" ? moved.content[0].text : "", /next library/);
	} finally {
		await rm(outside, { force: true });
		await rm(root, { recursive: true, force: true });
		await rm(nextRoot, { recursive: true, force: true });
	}
});

test("adapted Loom tool forwards arguments and abort, preserving image content and details", async () => {
	const controller = new AbortController();
	const details = { assetId: "asset-1" };
	const content = [
		{ type: "text" as const, text: "preview" },
		{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
	];
	const tool = toHarnessTool({
		name: "library_preview",
		description: "Preview an asset",
		parameters: Type.Object({ assetId: Type.String() }),
		execute: async (args, signal) => {
			assert.deepEqual(args, { assetId: "asset-1" });
			assert.equal(signal, controller.signal);
			return { content, details };
		},
	});
	assert.equal(tool.replay, "never");
	const result = await tool.execute(
		"preview-1", { assetId: "asset-1" }, () => {}, createWorkspaceTools().toolContext, invocation,
		withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
	);
	assert.equal(result.content, content);
	assert.equal(result.details, details);
});

test("adapted Loom tool converts plain text and does not start after abort", async () => {
	const controller = new AbortController();
	let calls = 0;
	const tool = toHarnessTool({
		name: "library_note",
		description: "Get a note",
		parameters: Type.Object({}),
		execute: () => {
			calls++;
			return "note";
		},
	});
	const context = createWorkspaceTools().toolContext;
	assert.deepEqual(
		(await tool.execute("note-1", {}, () => {}, context, invocation, BACKGROUND_CONTEXT)).content,
		[{ type: "text", text: "note" }],
	);
	controller.abort();
	await assert.rejects(
		tool.execute("note-2", {}, () => {}, context, invocation, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
	);
	assert.equal(calls, 1);
});
