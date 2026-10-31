import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfirmationQueue, type ChoiceOptions } from "../src/renderer/components/confirmation.ts";

const options: ChoiceOptions = {
	title: "Delete session?",
	description: "This cannot be undone.",
	tone: "danger",
	choices: [{ id: "delete", label: "Delete session", primary: true }],
};

describe("confirmation queue", () => {
	it("presents different callers one at a time and resolves their chosen actions", async () => {
		const queue = new ConfirmationQueue();
		const first = queue.request(options, Symbol());
		const request = queue.getSnapshot()!;
		const second = queue.request({ ...options, title: "Second question" }, Symbol());
		assert.equal(queue.getSnapshot(), request);
		queue.settle(request.id, "delete");
		assert.equal(await first, "delete");
		assert.equal(queue.getSnapshot()?.title, "Second question");
		queue.settle(queue.getSnapshot()!.id, null);
		assert.equal(await second, null);
		assert.equal(queue.getSnapshot(), null);
	});

	it("rejects repeat requests from a caller without queuing or executing twice", async () => {
		const queue = new ConfirmationQueue();
		const owner = Symbol();
		const first = queue.request(options, owner);
		assert.equal(await queue.request(options, owner), null);
		const id = queue.getSnapshot()!.id;
		queue.settle(id, "delete");
		assert.equal(await first, "delete");
		assert.equal(queue.getSnapshot(), null);
		const next = queue.request(options, owner);
		queue.settle(queue.getSnapshot()!.id, null);
		assert.equal(await next, null);
	});

	it("cancels both visible and queued questions when their callers go away", async () => {
		const queue = new ConfirmationQueue();
		const a = Symbol(), b = Symbol(), c = Symbol();
		const first = queue.request(options, a);
		const second = queue.request(options, b);
		const third = queue.request(options, c);
		queue.cancel(b);
		assert.equal(await second, null);
		assert.equal(queue.getSnapshot()?.id, 1);
		queue.cancel(a);
		assert.equal(await first, null);
		assert.equal(queue.getSnapshot()?.id, 3);
		queue.clear();
		assert.equal(await third, null);
		assert.equal(queue.getSnapshot(), null);
	});

	it("ignores stale responses and unlisted choices", async () => {
		const queue = new ConfirmationQueue();
		const first = queue.request(options, Symbol());
		const second = queue.request(options, Symbol());
		const request = queue.getSnapshot()!;
		queue.settle(request.id, "invalid");
		assert.equal(queue.getSnapshot(), request);
		queue.settle(request.id, "delete");
		assert.equal(await first, "delete");
		const next = queue.getSnapshot();
		queue.settle(request.id, "delete");
		assert.equal(queue.getSnapshot(), next);
		queue.clear();
		assert.equal(await second, null);
	});

	it("notifies subscribers and keeps snapshots stable until the active question changes", async () => {
		const queue = new ConfirmationQueue();
		let updates = 0;
		const unsubscribe = queue.subscribe(() => updates++);
		const result = queue.request(options, Symbol());
		assert.equal(updates, 1);
		assert.equal(queue.getSnapshot(), queue.getSnapshot());
		unsubscribe();
		queue.clear();
		assert.equal(updates, 1);
		assert.equal(await result, null);
	});

	it("preserves multiple action choices", async () => {
		const queue = new ConfirmationQueue();
		const result = queue.request({ ...options, choices: [
			{ id: "index", label: "Index only" },
			{ id: "describe", label: "Describe and index", primary: true },
		] }, Symbol());
		queue.settle(queue.getSnapshot()!.id, "index");
		assert.equal(await result, "index");
	});
});
