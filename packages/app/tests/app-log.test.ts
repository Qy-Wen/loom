import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendAppLog, appLogDirectory } from "../src/main/app-log.ts";

test("app log directory follows the platform logs folder", () => {
	assert.equal(appLogDirectory("darwin", {}, "/Users/loom"), join("/Users/loom", "Library", "Logs", "Loom"));
	assert.equal(appLogDirectory("win32", { APPDATA: "C:\\Users\\loom\\AppData\\Roaming" }, "C:\\Users\\loom"), join("C:\\Users\\loom\\AppData\\Roaming", "Loom", "logs"));
	assert.equal(appLogDirectory("win32", {}, "C:\\Users\\loom"), join("C:\\Users\\loom", "AppData", "Roaming", "Loom", "logs"));
});

test("app log rotates by size and keeps three files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "loom-app-log-"));
	try {
		appendAppLog(dir, "x".repeat(50), 10);
		assert.equal(await exists(join(dir, "main.log.1")), false);

		const first = await readFile(join(dir, "main.log"), "utf8");
		appendAppLog(dir, "two", Buffer.byteLength(first));
		const second = await readFile(join(dir, "main.log"), "utf8");
		assert.match(second, /two/);
		assert.match(await readFile(join(dir, "main.log.1"), "utf8"), /x{50}/);

		appendAppLog(dir, "three", Buffer.byteLength(second));
		const third = await readFile(join(dir, "main.log"), "utf8");
		appendAppLog(dir, "four", Buffer.byteLength(third));
		const kept = [
			await readFile(join(dir, "main.log"), "utf8"),
			await readFile(join(dir, "main.log.1"), "utf8"),
			await readFile(join(dir, "main.log.2"), "utf8"),
		].join("\n");
		assert.match(kept, /four/);
		assert.match(kept, /three/);
		assert.match(kept, /two/);
		assert.doesNotMatch(kept, /x{50}/);
		await assert.rejects(stat(join(dir, "main.log.3")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
