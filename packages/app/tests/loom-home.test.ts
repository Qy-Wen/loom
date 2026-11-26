import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loomConfigDir, migrateLoomHome } from "../src/main/loom-home.ts";

test("e2e keeps the isolated directory and production uses the home .loom directory", () => {
	assert.equal(loomConfigDir(true, "/tmp/e2e-user-data"), "/tmp/e2e-user-data");
	assert.equal(loomConfigDir(false, "/tmp/e2e-user-data").endsWith(`${join(".loom")}`), true);
});

test("migrateLoomHome moves settings and skills once and leaves an existing destination", async () => {
	const from = await mkdtemp(join(tmpdir(), "loom-home-from-"));
	const to = await mkdtemp(join(tmpdir(), "loom-home-to-"));
	try {
		await writeFile(join(from, "general.json"), "{\"language\":\"en\"}\n");
		await writeFile(join(to, "AGENTS.md"), "kept\n");
		await writeFile(join(from, "AGENTS.md"), "old\n");
		await mkdir(join(from, "skills", "brand-voice"), { recursive: true });
		await writeFile(join(from, "skills", "brand-voice", "SKILL.md"), "skill\n");
		await mkdir(join(from, "Cache"), { recursive: true });
		await writeFile(join(from, "Cache", "cache.bin"), "cache");

		const moved = await migrateLoomHome(from, to);
		assert.deepEqual([...moved].sort(), ["general.json", "skills"]);
		assert.equal(await readFile(join(to, "general.json"), "utf8"), "{\"language\":\"en\"}\n");
		assert.equal(await readFile(join(to, "skills", "brand-voice", "SKILL.md"), "utf8"), "skill\n");
		assert.equal(await readFile(join(to, "AGENTS.md"), "utf8"), "kept\n");
		assert.equal(await readFile(join(from, "AGENTS.md"), "utf8"), "old\n");
		assert.equal(await readFile(join(from, "Cache", "cache.bin"), "utf8"), "cache");
		assert.deepEqual(await migrateLoomHome(from, to), []);
		assert.deepEqual(await migrateLoomHome(to, to), []);
	} finally {
		await rm(from, { recursive: true, force: true });
		await rm(to, { recursive: true, force: true });
	}
});
