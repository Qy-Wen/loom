import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore, tryResolveMediaBinaries } from "@loom/core";
import type { LoomToolResult } from "@loom/agent";
import { createFfmpegTools } from "../src/main/tools/ffmpeg-tools.ts";

test("ffmpeg tools require an argv array", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-ffmpeg-tools-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "hero.mp4"), "not a real video");
		await core.openLibrary(root);
		const tools = createFfmpegTools(core);
		const run = tools.find((tool) => tool.name === "run_ffmpeg");
		assert.ok(run);
		await assert.rejects(Promise.resolve().then(() => run.execute({ args: "-i hero.mp4" })), /array of strings/);
		const probe = tools.find((tool) => tool.name === "run_ffprobe");
		assert.ok(probe);
		await assert.rejects(Promise.resolve().then(() => probe.execute({ args: "-i hero.mp4" })), /array of strings/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("run_ffmpeg writes a file when binaries are present", async (t) => {
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
		assert.ok(run);

		const generated = await run.execute({
			args: ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", "clip.mp4"],
		}) as LoomToolResult;
		assert.equal((generated.details as { output?: string }).output, "clip.mp4");

		const frame = await run.execute({ args: ["-ss", "0", "-i", "clip.mp4", "-frames:v", "1", "outputs/frame.jpg"] }) as LoomToolResult;
		assert.equal((frame.details as { output?: string }).output, "outputs/frame.jpg");
		const path = join(root, "outputs/frame.jpg");
		const original = await readFile(path);
		for (const flags of [[], ["-n"], ["-n", "-v", "quiet"], ["-nostdin", "-v", "quiet"]]) {
			await assert.rejects(
				async () => run.execute({ args: [...flags, "-ss", "0", "-i", "clip.mp4", "-frames:v", "1", "outputs/frame.jpg"] }),
				/ffmpeg refused to overwrite existing file: .*frame\.jpg/,
			);
			assert.deepEqual(await readFile(path), original);
		}
		await writeFile(path, "previous output");
		await run.execute({ args: ["-y", "-ss", "0", "-i", "clip.mp4", "-frames:v", "1", "outputs/frame.jpg"] });
		assert.deepEqual(await readFile(path), original);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("run_ffprobe returns stdout for a workspace-relative file", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "loom-ffprobe-run-"));
	const core = new LocalCore();
	try {
		await core.openLibrary(root);
		const tools = createFfmpegTools(core);
		const run = tools.find((tool) => tool.name === "run_ffmpeg")!;
		const probe = tools.find((tool) => tool.name === "run_ffprobe")!;
		await run.execute({ args: ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", "clip.mp4"] });
		const result = await probe.execute({ args: ["-v", "error", "-of", "json", "-show_entries", "stream=width", "clip.mp4"] }) as LoomToolResult;
		const details = result.details as { program: string; stdout?: string };
		assert.equal(details.program, "ffprobe");
		assert.equal(JSON.parse(details.stdout ?? "{}").streams[0].width, 64);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
