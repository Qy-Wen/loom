import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { runMediaProcess } from "../src/media/run.ts";
import { prepareSandboxedBash, processSandboxEnabled, sandboxedArgv, setProcessSandboxEnabled, setProcessSandboxFailureHandler, setProcessSandboxRoot } from "../src/sandbox/process-sandbox.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

// Exercise the Windows fallback on every host without provisioning users, ACLs or WFP.
for (const failure of ["none", "cleanup", "handler"] as const) test(`concurrent bash, argv and media wait for fallback cleanup and notification (${failure} failure)`, { timeout: 10_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "loom-sandbox-fallback-"));
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const previous = { SystemRoot: process.env.SystemRoot, ProgramFiles: process.env.ProgramFiles, LOOM_FFMPEG_PATH: process.env.LOOM_FFMPEG_PATH };
	const cleanupStarted = deferred();
	const cleanupDone = deferred();
	const noticeStarted = deferred();
	const noticeDone = deferred();
	const pending: Promise<unknown>[] = [];
	const completed: string[] = [];
	let notifications = 0;
	try {
		await mkdir(join(dir, "System32"));
		await mkdir(join(dir, "Git", "bin"), { recursive: true });
		await writeFile(join(dir, "System32", "cmd.exe"), "");
		await writeFile(join(dir, "Git", "bin", "bash.exe"), "");
		process.env.SystemRoot = dir;
		process.env.ProgramFiles = dir;
		process.env.LOOM_FFMPEG_PATH = process.execPath;
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		t.mock.method(SandboxManager, "isSupportedPlatform", () => true);
		t.mock.method(SandboxManager, "initialize", async () => { throw new Error("WFP fence inactive"); });
		t.mock.method(SandboxManager, "reset", async () => {
			cleanupStarted.resolve(); await cleanupDone.promise;
			if (failure === "cleanup") throw new Error("cleanup failed");
		});
		const logs: unknown[][] = [];
		t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
		setProcessSandboxRoot(dir);
		await setProcessSandboxEnabled(true);
		setProcessSandboxFailureHandler(async (error) => {
			notifications++;
			assert.match(error.message, /WFP fence inactive/);
			if (failure === "cleanup") assert.match(error.message, /Cleanup also failed: cleanup failed/);
			noticeStarted.resolve();
			await noticeDone.promise;
			if (failure === "handler") throw new Error("notice save failed");
		});
		pending.push(sandboxedArgv("echo initial", dir));
		await cleanupStarted.promise;
		assert.equal(processSandboxEnabled(), false);
		const queue = (label: string) => {
			const execution = { command: `echo ${label}`, cwd: dir, env: {} };
			pending.push(prepareSandboxedBash(execution).then(() => { assert.equal(execution.command, `echo ${label}`); completed.push(`bash-${label}`); }));
			pending.push(sandboxedArgv("echo argv", dir).then((wrapped) => { assert.equal(wrapped, undefined); completed.push(`argv-${label}`); }));
			pending.push(runMediaProcess({ program: "ffmpeg", args: ["-e", "require('fs').appendFileSync('ran.txt', 'ran\\n')"], cwd: dir }).then(() => { completed.push(`media-${label}`); }));
		};
		queue("cleanup");
		await nextTick();
		assert.deepEqual(completed, [], "commands must wait while cleanup is running");
		cleanupDone.resolve();
		await noticeStarted.promise;
		queue("notice");
		await nextTick();
		assert.deepEqual(completed, [], "commands must wait until the failure handler finishes");
		const controller = new AbortController();
		const cancelled = runMediaProcess({ program: "ffmpeg", args: ["-e", "require('fs').writeFileSync('cancelled.txt', 'bad')"], cwd: dir, signal: controller.signal });
		pending.push(assert.rejects(cancelled, /ffmpeg aborted/));
		controller.abort();
		noticeDone.resolve();
		await Promise.all(pending);
		assert.equal(notifications, 1);
		assert.equal(logs.length, failure === "handler" ? 1 : 0);
		assert.equal(completed.length, 6);
		assert.equal(await readFile(join(dir, "ran.txt"), "utf8"), "ran\nran\n");
		await assert.rejects(readFile(join(dir, "cancelled.txt")), { code: "ENOENT" });
	} finally {
		cleanupDone.resolve(); noticeDone.resolve();
		await Promise.allSettled(pending);
		setProcessSandboxFailureHandler(undefined);
		t.mock.restoreAll();
		Object.defineProperty(process, "platform", platform);
		await setProcessSandboxEnabled(true);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
