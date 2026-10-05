import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runMediaProcess } from "../src/media/run.ts";
import { releaseProcessSandbox, setProcessSandboxRoot } from "../src/sandbox/process-sandbox.ts";

test("runMediaProcess rejects immediately when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		runMediaProcess({
			program: "ffmpeg",
			args: ["-version"],
			signal: controller.signal,
		}),
		/ffmpeg aborted/,
	);
});

describe("sandboxed ffmpeg abort", { concurrency: false }, () => {
	test("runMediaProcess kills the child when aborted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-ffmpeg-abort-"));
		const binary = join(dir, "ffmpeg");
		await writeFile(binary, "#!/bin/sh\necho $$ > started.pid\nsleep 30\necho done > finished\n", { mode: 0o755 });
		const previous = process.env.LOOM_FFMPEG_PATH;
		process.env.LOOM_FFMPEG_PATH = binary;
		setProcessSandboxRoot(dir);
		const controller = new AbortController();
		try {
			const pending = runMediaProcess({
				program: "ffmpeg",
				args: ["-version"],
				cwd: dir,
				signal: controller.signal,
			});
			const started = await Promise.race([
				waitForFile(join(dir, "started.pid")).then(() => "started" as const),
				pending.then(() => "done" as const),
			]);
			assert.equal(started, "started");
			controller.abort();
			await assert.rejects(pending, /ffmpeg aborted/);
			const pid = Number((await readFile(join(dir, "started.pid"), "utf8")).trim());
			await waitUntilDead(pid);
			await assert.rejects(stat(join(dir, "finished")));
		} finally {
			if (previous === undefined) delete process.env.LOOM_FFMPEG_PATH;
			else process.env.LOOM_FFMPEG_PATH = previous;
			await releaseProcessSandbox(dir);
			await rm(dir, { recursive: true, force: true });
		}
	});
});

async function waitForFile(path: string): Promise<void> {
	const started = Date.now();
	for (;;) {
		try {
			await stat(path);
			return;
		} catch {
			if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${path}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

async function waitUntilDead(pid: number): Promise<void> {
	const started = Date.now();
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (Date.now() - started > 3_000) throw new Error(`sandboxed process ${pid} is still running`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
