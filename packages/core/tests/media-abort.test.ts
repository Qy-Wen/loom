import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runMediaProcess } from "../src/media/run.ts";

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

test("runMediaProcess kills the child when aborted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "loom-ffmpeg-abort-"));
	const binary = join(dir, "ffmpeg");
	await writeFile(binary, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
	const previous = process.env.LOOM_FFMPEG_PATH;
	process.env.LOOM_FFMPEG_PATH = binary;
	const controller = new AbortController();
	try {
		const pending = runMediaProcess({
			program: "ffmpeg",
			args: ["-version"],
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();
		await assert.rejects(pending, /ffmpeg aborted/);
	} finally {
		if (previous === undefined) delete process.env.LOOM_FFMPEG_PATH;
		else process.env.LOOM_FFMPEG_PATH = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
