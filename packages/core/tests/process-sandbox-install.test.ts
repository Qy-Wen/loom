import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { ensureWindowsSandboxInstalled, processSandboxEnabled, setProcessSandboxEnabled, setProcessSandboxFailureHandler, windowsSandboxSetup } from "../src/sandbox/process-sandbox.ts";

const spawn = { exe: "srt-win.exe", prependArgs: ["--srt-win"] };

test("packaged Windows sandbox install checks readiness and falls back when consent is refused", async (t) => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const calls: string[] = [];
	let ready = false;
	let install: { cancelled?: true } | Error = {};
	t.mock.method(windowsSandboxSetup, "resolve", () => {
		calls.push("resolve");
		return spawn;
	});
	t.mock.method(windowsSandboxSetup, "ready", async () => {
		calls.push("ready");
		return ready;
	});
	t.mock.method(windowsSandboxSetup, "install", async () => {
		calls.push("install");
		if (install instanceof Error) throw install;
		return install;
	});
	t.mock.method(SandboxManager, "reset", async () => {
		calls.push("reset");
	});
	const reasons: string[] = [];
	setProcessSandboxFailureHandler(async (error) => {
		reasons.push(error.message);
	});
	try {
		Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
		await setProcessSandboxEnabled(true);
		await ensureWindowsSandboxInstalled();
		assert.deepEqual(calls, [], "macOS and Linux do not install a Windows sandbox");

		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		await setProcessSandboxEnabled(false);
		await ensureWindowsSandboxInstalled();
		assert.deepEqual(calls, [], "an off setting does not ask for administrator consent");

		await setProcessSandboxEnabled(true);
		ready = true;
		assert.equal(await ensureWindowsSandboxInstalled(), "Windows sandbox already installed.");
		assert.deepEqual(calls, ["resolve", "ready"]);
		assert.equal(processSandboxEnabled(), true);

		calls.length = 0;
		ready = false;
		install = { cancelled: true };
		assert.equal(await ensureWindowsSandboxInstalled(), undefined);
		assert.deepEqual(calls, ["resolve", "ready", "install", "reset"]);
		assert.equal(processSandboxEnabled(), false);
		assert.deepEqual(reasons, ["The administrator prompt was cancelled."]);

		calls.length = 0;
		reasons.length = 0;
		install = new Error("WFP filter install failed");
		await setProcessSandboxEnabled(true);
		assert.equal(await ensureWindowsSandboxInstalled(), undefined);
		assert.deepEqual(calls, ["resolve", "ready", "install", "reset"]);
		assert.equal(processSandboxEnabled(), false);
		assert.deepEqual(reasons, ["WFP filter install failed"]);
	} finally {
		setProcessSandboxFailureHandler(undefined);
		t.mock.restoreAll();
		Object.defineProperty(process, "platform", platform);
		await setProcessSandboxEnabled(true);
	}
});
