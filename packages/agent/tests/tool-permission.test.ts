import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commandAllowId,
	commandAllowKey,
	DEFAULT_AGENT_PERMISSION,
	parseCommandAllows,
	gatedToolNames,
	parseAgentPermissionLevel,
	pathInsideWorkspace,
	toolCallNeedsApproval,
	toolNeedsApproval,
} from "../src/tools/tool-permission.ts";
import { workspaceWriteNeedsApproval } from "../src/tools/workspace-path.ts";

test("permission levels gate write, then bash, then nothing", () => {
	assert.equal(parseAgentPermissionLevel("nope"), DEFAULT_AGENT_PERMISSION);
	assert.deepEqual([...gatedToolNames("standard")].sort(), ["edit", "update_settings", "web_fetch", "write"]);
	assert.deepEqual([...gatedToolNames("basic")].sort(), ["bash", "edit", "grade_image", "run_ffmpeg", "update_settings", "web_fetch", "write"]);
	assert.equal(gatedToolNames("full").size, 0);
	assert.equal(toolNeedsApproval("standard", "write"), true);
	assert.equal(toolNeedsApproval("standard", "bash"), false);
	assert.equal(toolNeedsApproval("standard", "search_assets"), false);
	assert.equal(toolNeedsApproval("standard", "auto_memory"), false);
	assert.equal(toolNeedsApproval("basic", "auto_memory"), false);
	assert.equal(toolNeedsApproval("basic", "bash"), true);
	assert.equal(toolNeedsApproval("basic", "grade_image"), true);
	assert.equal(toolNeedsApproval("basic", "run_ffprobe"), false);
	assert.equal(toolNeedsApproval("standard", "grade_image"), false);
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
	assert.equal(toolCallNeedsApproval("standard", "update_settings", "/lib", {}), true);
	assert.equal(toolCallNeedsApproval("basic", "update_settings", "/lib", {}), true);
	assert.equal(toolCallNeedsApproval("full", "update_settings", "/lib", {}), false);
	assert.equal(toolNeedsApproval("standard", "get_settings"), false);
});

test("MCP calls require approval in Basic and Standard and allow per-tool grants", () => {
	for (const level of ["basic", "standard"] as const) {
		for (const name of ["publish__video", "comfy__generate", "unknown__read"]) {
			assert.equal(toolNeedsApproval(level, name), true);
			assert.equal(toolCallNeedsApproval(level, name, "/lib", { path: "inside.mp4" }), true);
			assert.equal(workspaceWriteNeedsApproval(level, name, "/lib", { path: "inside.mp4" }), true);
		}
		const grant = commandAllowKey("publish__video", { path: "first.mp4" });
		assert.deepEqual(grant, { tool: "publish__video" });
		assert.equal(toolCallNeedsApproval(level, "publish__video", "/lib", { path: "second.mp4" }, [grant!]), false);
		assert.equal(workspaceWriteNeedsApproval(level, "publish__video", "/lib", {}, [grant!]), false);
		assert.equal(toolCallNeedsApproval(level, "publish__comment", "/lib", {}, [grant!]), true);
		assert.equal(toolCallNeedsApproval(level, "another__video", "/lib", {}, [grant!]), true);
	}
	assert.equal(toolNeedsApproval("full", "publish__video"), false);
	assert.equal(workspaceWriteNeedsApproval("full", "publish__video", "/lib", {}), false);
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

test("remembered commands skip the next matching call", () => {
	const bash = commandAllowKey("bash", { command: "  git status  " });
	assert.deepEqual(bash, { tool: "bash", match: "git status" });
	assert.equal(commandAllowKey("bash", { command: "   " }), undefined);
	assert.equal(toolCallNeedsApproval("basic", "bash", "/lib", { command: "git status" }, bash ? [bash] : []), false);
	assert.equal(toolCallNeedsApproval("basic", "bash", "/lib", { command: "git status --short" }, bash ? [bash] : []), true);

	const write = commandAllowKey("write", { path: "notes/a.md" }, "/lib");
	const writeAbsolute = commandAllowKey("write", { path: "/lib/notes/a.md" }, "/lib");
	assert.equal(commandAllowId(write!), commandAllowId(writeAbsolute!));
	assert.notEqual(commandAllowId(write!), commandAllowId(commandAllowKey("write", { path: "/other/a.md" }, "/lib")!));
	assert.equal(toolCallNeedsApproval("basic", "write", "/lib", { path: "notes/a.md" }, write ? [write] : []), false);
	assert.equal(toolCallNeedsApproval("basic", "edit", "/lib", { path: "notes/a.md" }, write ? [write] : []), true);

	assert.deepEqual(commandAllowKey("grade_image", { path: "a.png" }), { tool: "grade_image" });
	assert.equal(toolCallNeedsApproval("basic", "grade_image", "/lib", { path: "b.png" }, [{ tool: "grade_image" }]), false);
	assert.equal(toolCallNeedsApproval("basic", "run_ffmpeg", "/lib", {}, [{ tool: "grade_image" }]), true);

	const ffmpeg = commandAllowKey("run_ffmpeg", { args: ["-i", "a.mp4"] });
	assert.equal(ffmpeg?.match, JSON.stringify(["ffmpeg", "-i", "a.mp4"]));
	assert.equal(toolNeedsApproval("basic", "run_ffprobe"), false);
	assert.equal(commandAllowKey("run_ffmpeg", { args: "nope" }), undefined);
	assert.equal(toolCallNeedsApproval("basic", "run_ffmpeg", "/lib", { args: ["-i", "a.mp4"] }, ffmpeg ? [ffmpeg] : []), false);

	assert.deepEqual(parseCommandAllows({
		allows: [bash, bash, { tool: "" }, { tool: "write", match: "" }, { nope: true }],
	}), bash ? [bash] : []);
	if (process.platform === "win32") {
		assert.equal(commandAllowKey("write", { path: "Notes/A.md" }, "/Lib")?.match, "notes/a.md");
	}
});

test("web_search never waits, web_fetch does, and Always remembers the site", () => {
	assert.equal(toolNeedsApproval("standard", "web_search"), false);
	assert.equal(toolNeedsApproval("standard", "web_fetch"), true);
	assert.equal(toolNeedsApproval("full", "web_fetch"), false);
	const key = commandAllowKey("web_fetch", { url: "https://Docs.Example.com/a?x=1" });
	assert.deepEqual(key, { tool: "web_fetch", match: "docs.example.com" });
	assert.equal(commandAllowKey("web_fetch", { url: "not a url" }), undefined);
	assert.equal(toolCallNeedsApproval("standard", "web_fetch", null, { url: "https://docs.example.com/b" }, [key!]), false);
	assert.equal(toolCallNeedsApproval("standard", "web_fetch", null, { url: "https://evil.example.com/b" }, [key!]), true);
});
