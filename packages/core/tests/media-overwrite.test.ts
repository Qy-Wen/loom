import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tryResolveMediaBinaries } from "../src/media/binaries.ts";
import { runMediaProcess } from "../src/media/run.ts";
import { releaseProcessSandbox, setProcessSandboxEnabled, setProcessSandboxRoot } from "../src/sandbox/process-sandbox.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures/media");

for (const sandbox of [true, false]) {
	test(`FFmpeg overwrite refusals reject with sandbox ${sandbox ? "on" : "off"}`, async (t) => {
		if (!tryResolveMediaBinaries()) {
			t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
			return;
		}
		const root = await mkdtemp(join(tmpdir(), "loom-media-overwrite-"));
		const output = "existing frame's image.png";
		setProcessSandboxRoot(root);
		try {
			await setProcessSandboxEnabled(sandbox);
			await copyFile(join(FIXTURES, "clip.mp4"), join(root, "clip.mp4"));
			await copyFile(join(FIXTURES, "still.png"), join(root, output));
			const original = await readFile(join(root, output));
			for (const flags of [
				[], ["-n"], ["-nostdin"], ["-v", "quiet"], ["-n", "-v", "level+fatal"],
				["-n", "-v", "quiet"], ["-nostdin", "-loglevel", "quiet"],
				["-n", "-loglevel", "repeat+level+quiet"], ["-n", "-v", "-8"],
				["-n", "-v", "level+-8"], ["-n", "-v", "panic"],
			]) {
				await assert.rejects(
					runMediaProcess({
						program: "ffmpeg",
						args: [...flags, "-i", "clip.mp4", "-frames:v", "1", output],
						cwd: root,
					}),
					/ffmpeg refused to overwrite existing file: .*existing frame's image\.png/,
				);
				assert.deepEqual(await readFile(join(root, output)), original);
			}
			// Normal diagnostics and an explicit overwrite must still succeed.
			await runMediaProcess({ program: "ffmpeg", args: ["-version"], cwd: root });
			await runMediaProcess({ program: "ffmpeg", args: ["-y", "-i", "clip.mp4", "-frames:v", "1", output], cwd: root });
			assert.notDeepEqual(await readFile(join(root, output)), original);
		} finally {
			await releaseProcessSandbox(root);
			await setProcessSandboxEnabled(true);
			await rm(root, { recursive: true, force: true });
		}
	});
}
