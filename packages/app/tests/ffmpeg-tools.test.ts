import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore, tryResolveMediaBinaries } from "@loom/core";
import type { LoomToolResult } from "@loom/agent";
import { createFfmpegTools } from "../src/main/ffmpeg-tools.ts";

test("ffmpeg tools reject jail breaks and require relative paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-ffmpeg-tools-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "hero.mp4"), "not a real video");
		await core.openLibrary(root);
		const tools = createFfmpegTools(core);
		const info = tools.find((tool) => tool.name === "get_media_info");
		const run = tools.find((tool) => tool.name === "run_ffmpeg");
		assert.ok(info && run);

		await assert.rejects(Promise.resolve().then(() => info.execute({ path: "" })), /non-empty/);
		await assert.rejects(Promise.resolve().then(() => info.execute({ path: "../escape.mp4" })), /outside the library/);
		await assert.rejects(
			Promise.resolve().then(() => run.execute({ args: ["-i", "https://x/a.mp4", "out.mp4"] })),
			/sandbox/i,
		);
		await assert.rejects(Promise.resolve().then(() => run.execute({ args: "-i hero.mp4" })), /array of strings/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("ffmpeg tools can extract a frame when binaries are present", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "loom-ffmpeg-run-"));
	const core = new LocalCore();
	try {
		await core.openLibrary(root);
		const tools = createFfmpegTools(core);
		const run = tools.find((tool) => tool.name === "run_ffmpeg");
		const frame = tools.find((tool) => tool.name === "extract_frame");
		assert.ok(run && frame);

		const generated = await run.execute({
			args: ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", "clip.mp4"],
		}) as LoomToolResult;
		assert.equal((generated.details as { output?: string }).output, "clip.mp4");
		assert.equal(JSON.stringify(generated).includes(root), false);

		const result = await frame.execute({ path: "clip.mp4", timeSeconds: 0 }) as LoomToolResult;
		assert.equal((result.details as { output?: string }).output, "outputs/clip_extract_frame.jpg");
		assert.equal(JSON.stringify(result).includes(root), false);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
