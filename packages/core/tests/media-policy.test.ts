import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { MediaPolicyError, prepareFfmpegArgs, resolveMediaPath } from "../src/media/policy.ts";

test("resolveMediaPath accepts relative and absolute paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-media-policy-"));
	try {
		assert.equal(resolveMediaPath("clips/hero.mp4", root).path, "clips/hero.mp4");
		assert.equal(resolveMediaPath("outputs/clip.mp4", root).path, "outputs/clip.mp4");
		assert.equal(resolveMediaPath("../escape.mp4", root).absolutePath, resolve(root, "..", "escape.mp4"));
		assert.equal(resolveMediaPath(join(root, "hero.mp4"), root).path, "hero.mp4");
		assert.throws(() => resolveMediaPath("", root), MediaPolicyError);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prepareFfmpegArgs rewrites file operands against cwd", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-media-args-"));
	try {
		const prepared = prepareFfmpegArgs(
			["-i", "clips/hero.mp4", "-vf", "scale=1080:1920", "shorts/out.mp4"],
			root,
		);
		assert.equal(prepared.outputPaths.includes("shorts/out.mp4"), true);
		assert.equal(prepared.args.includes("clips/hero.mp4"), false);
		assert.equal(prepared.args.some((arg) => arg.endsWith("hero.mp4")), true);

		const remote = prepareFfmpegArgs(["-i", "https://x/a.mp4", "out.mp4"], root);
		assert.equal(remote.args.includes("https://x/a.mp4"), true);
		assert.throws(() => prepareFfmpegArgs("-i clips/hero.mp4", root), /array of strings/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
