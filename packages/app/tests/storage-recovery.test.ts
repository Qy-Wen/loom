import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentStatsStore } from "../src/main/chat/agent-stats-store.ts";
import { LastLibraryStore } from "../src/main/desktop/last-library-store.ts";
import { DeviceIdStore } from "../src/main/models/device-id-store.ts";
import { ModelSettingsStore } from "../src/main/models/model-settings-store.ts";
import { AgentPermissionStore } from "../src/main/settings/agent-permission-store.ts";
import { AgentSandboxStore } from "../src/main/settings/agent-sandbox-store.ts";
import { GeneralSettingsStore } from "../src/main/settings/general-settings-store.ts";
import { JsonFile, setStorageRecoveryLogger } from "../src/main/storage/file.ts";

const TRUNCATED = '{"half":';

async function directory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "loom-corrupt-"));
}

async function backups(dir: string, name: string): Promise<string[]> {
	return (await readdir(dir)).filter((entry) => entry.startsWith(`${name}.corrupt-`));
}

describe("a corrupt settings file does not stop the app", () => {
	const cases: Array<[string, (path: string) => Promise<unknown>]> = [
		["general.json", (path) => new GeneralSettingsStore(path).load()],
		["model-settings.json", (path) => new ModelSettingsStore(path).load()],
		["agent-permission.json", (path) => new AgentPermissionStore(path).load()],
		["agent-sandbox.json", (path) => new AgentSandboxStore(path).load()],
		["last-library.json", (path) => new LastLibraryStore(path).load()],
		["agent-stats.json", (path) => new AgentStatsStore(path).load()],
	];

	for (const [name, load] of cases) {
		it(`${name}: keeps the bad file aside and starts from defaults`, async () => {
			const dir = await directory();
			const path = join(dir, name);
			await writeFile(path, TRUNCATED);
			await load(path);
			const kept = await backups(dir, name);
			assert.equal(kept.length, 1, "exactly one backup");
			assert.equal(await readFile(join(dir, kept[0]!), "utf8"), TRUNCATED, "the content is preserved, not deleted");
			assert.deepEqual((await readdir(dir)).filter((entry) => entry === name), [], "the bad file no longer blocks the name");
		});
	}

	it("saving after recovery writes a fresh, valid file and leaves the backup alone", async () => {
		const dir = await directory();
		const path = join(dir, "general.json");
		await writeFile(path, TRUNCATED);
		const store = new GeneralSettingsStore(path);
		const saved = await store.save({ language: "zh-CN" });
		assert.equal(saved.language, "zh-CN");
		assert.equal((await new GeneralSettingsStore(path).load()).language, "zh-CN");
		assert.equal((await backups(dir, "general.json")).length, 1);
	});

	it("reports each recovery to the log", async () => {
		const dir = await directory();
		const path = join(dir, "agent-stats.json");
		await writeFile(path, TRUNCATED);
		const lines: string[] = [];
		setStorageRecoveryLogger((line) => lines.push(line));
		try {
			await new AgentStatsStore(path).load();
		} finally {
			setStorageRecoveryLogger(undefined);
		}
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /agent-stats\.json/);
		assert.match(lines[0]!, /corrupt-/);
	});

	it("a healthy file is left exactly as it is", async () => {
		const dir = await directory();
		const path = join(dir, "general.json");
		await new GeneralSettingsStore(path).save({ language: "en" });
		const before = await readFile(path, "utf8");
		assert.equal((await new GeneralSettingsStore(path).load()).language, "en");
		assert.equal(await readFile(path, "utf8"), before);
		assert.deepEqual(await backups(dir, "general.json"), []);
	});
});

describe("files where a silent reset would be wrong still fail loudly", () => {
	it("the installation id is never replaced", async () => {
		const dir = await directory();
		const path = join(dir, "device-id.json");
		await writeFile(path, TRUNCATED);
		await assert.rejects(() => new DeviceIdStore(path).get(), /invalid/i);
		assert.equal(await readFile(path, "utf8"), TRUNCATED);
		assert.deepEqual(await backups(dir, "device-id.json"), []);
	});

	it("a plain JsonFile (no recovery) throws and does not touch the file", async () => {
		const dir = await directory();
		const path = join(dir, "x.json");
		await writeFile(path, TRUNCATED);
		await assert.rejects(() => new JsonFile(path, (value) => value).read(), /Invalid JSON/);
		assert.equal(await readFile(path, "utf8"), TRUNCATED);
		assert.deepEqual(await backups(dir, "x.json"), []);
	});
});

describe("last-library and agent-stats are written atomically", () => {
	it("leaves no temporary file behind and the content is valid JSON", async () => {
		const dir = await directory();
		const library = new LastLibraryStore(join(dir, "last-library.json"));
		await library.remember("/data/Assets");
		const stats = new AgentStatsStore(join(dir, "agent-stats.json"));
		await stats.record({ input: 3, output: 4, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual((await readdir(dir)).sort(), ["agent-stats.json", "last-library.json"]);
		assert.equal(JSON.parse(await readFile(join(dir, "last-library.json"), "utf8")).rootPath, "/data/Assets");
		assert.equal(JSON.parse(await readFile(join(dir, "agent-stats.json"), "utf8")).input, 3);
	});

	it("still round-trips", async () => {
		const dir = await directory();
		await new LastLibraryStore(join(dir, "last-library.json")).remember("  /data/Assets  ");
		assert.equal(await new LastLibraryStore(join(dir, "last-library.json")).load(), "/data/Assets");
		const first = new AgentStatsStore(join(dir, "agent-stats.json"));
		await first.record({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
		await first.record({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
		const again = await new AgentStatsStore(join(dir, "agent-stats.json")).load();
		assert.deepEqual([again.turns, again.input, again.output, again.cacheRead, again.cacheWrite], [2, 2, 4, 6, 8]);
	});
});
