import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceIdStore } from "../src/main/models/device-id-store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function directory(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "loom-device-id-"));
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	return dir;
}

test("device ID is created on first use and is the same afterwards, across instances", async (t) => {
	const path = join(await directory(t), "device-id.json");
	const first = await new DeviceIdStore(path).get();
	assert.match(first, UUID);
	assert.equal(await new DeviceIdStore(path).get(), first, "a new process reads the stored ID");
	const store = new DeviceIdStore(path);
	assert.equal(await store.get(), await store.get());
	assert.equal(JSON.parse(await readFile(path, "utf8")).deviceId, first);
});

test("concurrent first calls agree on one ID", async (t) => {
	const path = join(await directory(t), "device-id.json");
	const ids = await Promise.all(Array.from({ length: 6 }, () => new DeviceIdStore(path).get()));
	assert.equal(new Set(ids).size, 1);
});

test("an unreadable file is reported and never replaced with a new identity", async (t) => {
	const path = join(await directory(t), "device-id.json");
	await writeFile(path, JSON.stringify({ deviceId: "not-a-uuid" }));
	await assert.rejects(() => new DeviceIdStore(path).get(), /invalid/i);
	assert.equal(JSON.parse(await readFile(path, "utf8")).deviceId, "not-a-uuid");
});
