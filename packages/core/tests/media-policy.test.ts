import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LibraryPaths } from "../src/library/paths.ts";
import { MediaPolicyError, prepareFfmpegArgs, resolveLibraryPath } from "../src/media/policy.ts";

test("resolveLibraryPath accepts relative paths and rejects jail breaks", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-media-policy-"));
	try {
		const paths = new LibraryPaths(root);
		assert.equal(resolveLibraryPath("clips/hero.mp4", paths).relativePath, "clips/hero.mp4");
		assert.equal(resolveLibraryPath("outputs/clip.mp4", paths).relativePath, "outputs/clip.mp4");
		assert.throws(() => resolveLibraryPath("../escape.mp4", paths), MediaPolicyError);
		assert.throws(() => resolveLibraryPath(join(root, "..", "outside.mp4"), paths), MediaPolicyError);
		assert.throws(() => resolveLibraryPath(".loom/secret.mp4", paths), /loom/i);
		assert.throws(() => resolveLibraryPath("http://example.com/a.mp4", paths), /sandbox/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prepareFfmpegArgs rewrites relative files and rejects protocols", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-media-args-"));
	try {
		const paths = new LibraryPaths(root);
		const prepared = prepareFfmpegArgs(
			["-i", "clips/hero.mp4", "-vf", "scale=1080:1920", "shorts/out.mp4"],
			paths,
		);
		assert.equal(prepared.outputRelativePaths.includes("shorts/out.mp4"), true);
		assert.equal(prepared.args.includes("clips/hero.mp4"), false);
		assert.equal(prepared.args.some((arg) => arg.endsWith("hero.mp4")), true);

		assert.throws(() => prepareFfmpegArgs(["-i", "https://x/a.mp4", "out.mp4"], paths), /sandbox/i);
		assert.throws(() => prepareFfmpegArgs(["-i", "concat:a|b", "out.mp4"], paths), /sandbox/i);
		assert.throws(() => prepareFfmpegArgs(["-filter_complex", "movie=secret.mp4"], paths), /sandbox/i);
		assert.throws(() => prepareFfmpegArgs("-i clips/hero.mp4", paths), /array of strings/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
