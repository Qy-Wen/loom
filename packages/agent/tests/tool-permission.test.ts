import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_AGENT_PERMISSION,
	ToolApprovalQueue,
	gatedToolNames,
	parseAgentPermissionLevel,
	pathInsideWorkspace,
	toolCallNeedsApproval,
	toolNeedsApproval,
} from "../src/tool-permission.ts";
import { workspaceWriteNeedsApproval } from "../src/workspace-path.ts";

test("permission levels gate write, then bash, then nothing", () => {
	assert.equal(parseAgentPermissionLevel("nope"), DEFAULT_AGENT_PERMISSION);
	assert.deepEqual([...gatedToolNames("standard")].sort(), ["edit", "write"]);
	assert.deepEqual([...gatedToolNames("basic")].sort(), ["bash", "convert_format", "crop_video", "edit", "extract_clip", "extract_frame", "resize_video", "run_ffmpeg", "write"]);
	assert.equal(gatedToolNames("full").size, 0);
	assert.equal(toolNeedsApproval("standard", "write"), true);
	assert.equal(toolNeedsApproval("standard", "bash"), false);
	assert.equal(toolNeedsApproval("standard", "search_assets"), false);
	assert.equal(toolNeedsApproval("standard", "auto_memory"), false);
	assert.equal(toolNeedsApproval("basic", "auto_memory"), false);
	assert.equal(toolNeedsApproval("basic", "bash"), true);
	assert.equal(toolNeedsApproval("basic", "extract_frame"), true);
	assert.equal(toolNeedsApproval("basic", "get_media_info"), false);
	assert.equal(toolNeedsApproval("standard", "extract_frame"), false);
	assert.equal(toolNeedsApproval("standard", "run_ffmpeg"), false);
	assert.equal(toolNeedsApproval("full", "write"), false);
	assert.equal(pathInsideWorkspace("/lib", "notes/a.md"), true);
	assert.equal(pathInsideWorkspace("/lib", "/lib/notes/a.md"), true);
	assert.equal(pathInsideWorkspace("/lib", "/lib"), true);
	assert.equal(pathInsideWorkspace("/lib", "../secret.md"), false);
	assert.equal(pathInsideWorkspace("/lib", "/lib-extra/a.md"), false);
	assert.equal(pathInsideWorkspace("/lib", "sub/../../etc/passwd"), false);
	assert.equal(toolCallNeedsApproval("standard", "write", "/lib", { path: "notes/a.md" }), false);
	assert.equal(toolCallNeedsApproval("standard", "edit", "/lib", { path: "/other/a.md" }), true);
	assert.equal(toolCallNeedsApproval("standard", "write", "/lib", {}), true);
	assert.equal(toolCallNeedsApproval("basic", "write", "/lib", { path: "notes/a.md" }), true);
	assert.equal(toolCallNeedsApproval("full", "write", "/lib", { path: "/other/a.md" }), false);
	assert.equal(toolCallNeedsApproval("standard", "bash", "/lib", { command: "ls" }), false);
});

test("standard follows a symlink out of the library", () => {
	const root = mkdtempSync(join(tmpdir(), "loom-write-scope-"));
	const outside = mkdtempSync(join(tmpdir(), "loom-write-out-"));
	try {
		symlinkSync(outside, join(root, "link"));
		assert.equal(workspaceWriteNeedsApproval("standard", "write", root, { path: "notes/a.md" }), false);
		assert.equal(workspaceWriteNeedsApproval("standard", "edit", root, { path: "link/note.md" }), true);
		assert.equal(workspaceWriteNeedsApproval("standard", "write", root, { path: join(root, "..", "nope.md") }), true);
		assert.equal(workspaceWriteNeedsApproval("standard", "write", root, { path: join(realpathSync(root), "inside.md") }), false);
		assert.equal(workspaceWriteNeedsApproval("basic", "write", root, { path: "notes/a.md" }), true);
		const sibling = mkdtempSync(join(tmpdir(), "loom-write-sibling-"));
		try {
			assert.equal(workspaceWriteNeedsApproval("standard", "write", root, { path: join(sibling, "a.md") }), true);
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("ToolApprovalQueue waits until resolve or abort", async () => {
	const queue = new ToolApprovalQueue();
	const waiting = queue.wait("s1", "call-1");
	assert.equal(queue.size, 1);
	assert.equal(queue.resolve("missing", "approve"), false);
	assert.equal(queue.resolve("call-1", "reject"), true);
	assert.equal(await waiting, "reject");
	assert.equal(queue.size, 0);
	assert.equal(queue.resolve("call-1", "approve"), false);

	const controller = new AbortController();
	const aborted = queue.wait("s1", "call-2", controller.signal);
	controller.abort();
	assert.equal(await aborted, "abort");

	const sessionWait = queue.wait("s1", "call-3");
	queue.wait("s2", "call-4");
	queue.abortSession("s1");
	assert.equal(await sessionWait, "abort");
	assert.equal(queue.resolve("call-4", "approve"), true);

	const auto = queue.wait("s3", "call-5");
	queue.approveAll();
	assert.equal(await auto, "approve");
	assert.equal(queue.size, 0);
});
