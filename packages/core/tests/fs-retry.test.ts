import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { retryWindowsFileOperation } from "../src/fs-retry.ts";

function platform(t: TestContext, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...descriptor, value });
	t.after(() => Object.defineProperty(process, "platform", descriptor));
}

test("Windows file retries recover from sharing violations and return the operation result", async (t) => {
	platform(t, "win32");
	const failures = ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"];
	let attempts = 0;
	const result = await retryWindowsFileOperation(async () => {
		const code = failures[attempts++];
		if (code) throw Object.assign(new Error("busy"), { code });
		return "saved";
	});
	assert.equal(result, "saved");
	assert.equal(attempts, 5);
});

test("Windows file retries stop at the deadline with the original error", async (t) => {
	platform(t, "win32");
	const error = Object.assign(new Error("still locked"), { code: "EPERM" });
	let attempts = 0;
	const started = performance.now();
	await assert.rejects(retryWindowsFileOperation(async () => { attempts++; throw error; }, { timeoutMs: 30 }), (caught) => caught === error);
	assert.ok(attempts > 1);
	assert.ok(performance.now() - started >= 30);
});

test("filesystem retry guards run on every attempt and guard errors are never retried", async (t) => {
	platform(t, "win32");
	let attempts = 0, checks = 0;
	const lost = Object.assign(new Error("ownership lost"), { code: "EPERM" });
	await assert.rejects(retryWindowsFileOperation(async () => {
		attempts++;
		throw Object.assign(new Error("file busy"), { code: "EBUSY" });
	}, { beforeAttempt: () => { if (++checks === 2) throw lost; } }), (caught) => caught === lost);
	assert.equal(attempts, 1);
	assert.equal(checks, 2);
});

test("other platforms and permanent filesystem errors fail without retrying", async (t) => {
	for (const [os, code] of [["darwin", "EPERM"], ["win32", "ENOENT"], ["win32", "EIO"]]) {
		await t.test(`${os}: ${code}`, async (t) => {
			platform(t, os);
			let attempts = 0;
			const error = Object.assign(new Error("failed"), { code });
			await assert.rejects(retryWindowsFileOperation(async () => { attempts++; throw error; }), (caught) => caught === error);
			assert.equal(attempts, 1);
		});
	}
});
