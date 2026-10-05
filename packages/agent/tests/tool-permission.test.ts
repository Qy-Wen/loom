import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_AGENT_PERMISSION,
	ToolApprovalQueue,
	gatedToolNames,
	parseAgentPermissionLevel,
	toolNeedsApproval,
} from "../src/tool-permission.ts";

test("permission levels gate write, then bash, then nothing", () => {
	assert.equal(parseAgentPermissionLevel("nope"), DEFAULT_AGENT_PERMISSION);
	assert.deepEqual([...gatedToolNames("standard")].sort(), ["edit", "write"]);
	assert.deepEqual([...gatedToolNames("basic")].sort(), ["bash", "edit", "write"]);
	assert.equal(gatedToolNames("full").size, 0);
	assert.equal(toolNeedsApproval("standard", "write"), true);
	assert.equal(toolNeedsApproval("standard", "bash"), false);
	assert.equal(toolNeedsApproval("standard", "search_assets"), false);
	assert.equal(toolNeedsApproval("standard", "memory"), false);
	assert.equal(toolNeedsApproval("basic", "memory"), false);
	assert.equal(toolNeedsApproval("basic", "bash"), true);
	assert.equal(toolNeedsApproval("full", "write"), false);
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
