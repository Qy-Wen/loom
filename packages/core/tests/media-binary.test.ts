import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaOutputLimitError, runMediaProcessBuffer } from "../src/media/run.ts";
import { setProcessSandboxEnabled } from "../src/sandbox/process-sandbox.ts";

test("media pipes preserve arbitrary bytes and handle a closed stdin", async () => {
	const previous = process.env.LOOM_FFMPEG_PATH;
	process.env.LOOM_FFMPEG_PATH = process.execPath;
	await setProcessSandboxEnabled(false);
	try {
		const bytes = Buffer.from([0, 255, 128, 195, 40, 254, 10]);
		const result = await runMediaProcessBuffer({
			program: "ffmpeg", args: ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('diagnostic')"], input: bytes,
		});
		assert.deepEqual(result.stdout, bytes);
		assert.equal(result.stderr, "diagnostic");
		const early = await runMediaProcessBuffer({
			program: "ffmpeg", args: ["-e", "process.stdout.write(Buffer.from([255,216,255])); process.exit(0)"],
			input: Buffer.alloc(4 * 1024 * 1024),
		});
		assert.deepEqual(early.stdout, Buffer.from([255, 216, 255]));
		await assert.rejects(runMediaProcessBuffer({
			program: "ffmpeg", args: ["-e", "process.stdout.write(Buffer.alloc(8192)); setInterval(()=>{},1000)"], maxOutputBytes: 1024,
		}), MediaOutputLimitError);
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(runMediaProcessBuffer({ program: "ffmpeg", args: [], signal: abort.signal }), { name: "AbortError" });
	} finally {
		if (previous === undefined) delete process.env.LOOM_FFMPEG_PATH;
		else process.env.LOOM_FFMPEG_PATH = previous;
		await setProcessSandboxEnabled(true);
	}
});
