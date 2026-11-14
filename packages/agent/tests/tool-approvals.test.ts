import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolApprovals, type PendingToolApproval, type ToolApprovalObserver } from "../src/tools/approvals.ts";

const root = process.cwd();
const call = (id = "external:1"): PendingToolApproval => ({ toolCallId: id, toolName: "update_settings", args: { sandbox: false } });

for (const outcome of ["approve", "reject", "abort", "full"] as const) {
	test(`transport-independent approvals: ${outcome} cleans up its pending request`, { timeout: 5_000 }, async () => {
		const approvals = new ToolApprovals();
		const controller = new AbortController();
		const ready = Promise.withResolvers<PendingToolApproval>();
		const settled: string[] = [];
		const observer: ToolApprovalObserver = { pending: async (pending) => { ready.resolve(pending); }, settled: async (pending) => { settled.push(pending.toolCallId); } };
		const request = approvals.request(root, call(), observer, controller.signal);
		const pending = await ready.promise;
		assert.deepEqual(pending.args, { sandbox: false });
		assert.deepEqual(approvals.pendingCommandAllow(pending.toolCallId, root), { tool: "update_settings" });
		if (outcome === "abort") controller.abort();
		else if (outcome === "full") approvals.setLevel("full");
		else assert.equal(approvals.resolve(pending.toolCallId, outcome), true);
		assert.equal(await request, outcome === "full" ? "approve" : outcome);
		assert.deepEqual(settled, [pending.toolCallId]);
		assert.equal(approvals.resolve(pending.toolCallId, "approve"), false);
	});
}

test("distinct clients can wait independently and duplicate identities cannot replace a wait", { timeout: 5_000 }, async () => {
	const approvals = new ToolApprovals();
	const pending: string[] = [];
	const observer = { pending: async (item: PendingToolApproval) => { pending.push(item.toolCallId); }, settled: async () => {} };
	const first = approvals.request(root, call("client-a:1"), observer);
	const second = approvals.request(root, call("client-b:1"), observer);
	await assert.rejects(approvals.request(root, call("client-a:1"), observer), /Duplicate/);
	assert.deepEqual(pending, ["client-a:1", "client-b:1"]);
	approvals.resolve("client-b:1", "reject");
	approvals.resolve("client-a:1", "approve");
	assert.deepEqual(await Promise.all([first, second]), ["approve", "reject"]);
});

test("failed publication cleans up and remembered tools need no new approval", async () => {
	const approvals = new ToolApprovals();
	let cleaned = false;
	await assert.rejects(approvals.request(root, call(), { pending: async () => { throw new Error("UI closed"); }, settled: async () => { cleaned = true; } }), /UI closed/);
	assert.equal(cleaned, true);
	assert.equal(approvals.resolve(call().toolCallId, "approve"), false);
	approvals.allows = [{ tool: "update_settings" }];
	assert.equal(await approvals.request(root, call(), { pending: async () => { throw new Error("Unexpected approval"); }, settled: async () => {} }), "approve");
});
