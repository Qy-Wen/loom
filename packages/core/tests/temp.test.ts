import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LocalCore, tryResolveMediaBinaries } from "../src/index.ts";
import { STALE_TEMP_MS, TEMP_ROOT_NAME, ensureTempDir, ensureTempRoot, ensureTempRootSync, makeTempDir, sweepStaleTemp } from "../src/temp.ts";

/** `os.tmpdir()` reads TMPDIR (POSIX) or TEMP/TMP (Windows) on every call. */
async function withTempEnv<T>(dir: string, run: () => Promise<T>): Promise<T> {
	const names = process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"];
	const saved = names.map((name) => [name, process.env[name]] as const);
	for (const name of names) process.env[name] = dir;
	try {
		return await run();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("all Loom temp paths sit under one <tmpdir>/loom root, created even when TMPDIR is missing", async () => {
	const parent = await mkdtemp(join(tmpdir(), "loom-te-"));
	try {
		const missing = join(parent, "a", "b");
		await withTempEnv(missing, async () => {
			const root = join(missing, TEMP_ROOT_NAME);
			await assert.rejects(stat(missing), { code: "ENOENT" });
			assert.equal(await ensureTempRoot(), root);
			assert.equal(await ensureTempRoot(), root);
			assert.equal(ensureTempRootSync(), root);
			assert.equal(await ensureTempDir("sandbox"), join(root, "sandbox"));
			const run = await makeTempDir("grade");
			assert.equal(dirname(run), join(root, "grade"));
			assert.equal((await stat(run)).isDirectory(), true);
			assert.deepEqual((await readdir(missing)).sort(), [TEMP_ROOT_NAME]);
		});
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("sweepStaleTemp removes entries older than a day and keeps fresh ones", async () => {
	const parent = await mkdtemp(join(tmpdir(), "loom-te-"));
	try {
		await withTempEnv(parent, async () => {
			const old = await makeTempDir("grade");
			const fresh = await makeTempDir("grade");
			await writeFile(join(old, "frame.jpg"), "x");
			const past = new Date(Date.now() - STALE_TEMP_MS - 60_000);
			await utimes(old, past, past);
			const helper = join(await ensureTempDir("sandbox"), "spawn.cjs");
			await writeFile(helper, "x");
			await utimes(helper, past, past);

			await sweepStaleTemp();
			await assert.rejects(stat(old), { code: "ENOENT" });
			await assert.rejects(stat(helper), { code: "ENOENT" });
			assert.equal((await stat(fresh)).isDirectory(), true);
			await sweepStaleTemp();
		});
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("grade preview works when TMPDIR points at a missing directory, and leaves nothing behind", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}
	const parent = await mkdtemp(join(tmpdir(), "loom-te-"));
	const root = join(parent, "lib");
	// Unix socket paths are limited to ~104 bytes, and the sandbox creates sockets inside the temp dir.
	const missing = join(parent, "t");
	const core = new LocalCore();
	try {
		await mkdir(root);
		await copyFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "still.png"), join(root, "still.png"));
		await withTempEnv(missing, async () => {
			const snapshot = await core.openLibrary(root);
			const id = snapshot.assets.find((asset) => asset.relativePath === "still.png")!.assetId;
			const preview = await core.previewImageGrade(id, { exposure: 1 });
			assert.ok(preview && preview.length > 100);
			assert.deepEqual(await readdir(join(missing, TEMP_ROOT_NAME, "grade")).then((names) => names.length), 1);
			await core.close();
			assert.deepEqual(await readdir(join(missing, TEMP_ROOT_NAME, "grade")), []);
			assert.equal((await readdir(join(missing, TEMP_ROOT_NAME))).some((name) => name.startsWith("loom-")), false);
		});
	} finally {
		await core.close();
		await rm(parent, { recursive: true, force: true });
	}
});
