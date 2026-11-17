import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context, LibraryRuntime } from "@loom/agent/durable";
import { ChatService } from "../src/main/chat/chat-service.ts";
import { CloudConfigStore } from "../src/main/cloud-backup/config.ts";
import { CloudBackupController } from "../src/main/cloud-backup/controller.ts";
import { captureSnapshot, readRestoreMarker, relocatedCwd, validateBackupPath } from "../src/main/cloud-backup/snapshot.ts";
import type { ObjectStore } from "../src/main/cloud-backup/object-store.ts";
import { listCloudLibraries, restoreMirror, updateMirror, mirrorRoot, mirrorManifestKey, libraryCatalogKey, type MirrorManifest } from "../src/main/cloud-backup/mirror.ts";
import type { CloudLibrary } from "../src/shared/cloud-backup.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";

class MemoryStore implements ObjectStore {
	objects = new Map<string, Buffer>();
	uploads: string[] = [];
	fail?: (key: string) => boolean;
	afterDownload?: (key: string) => void;
	removed: string[] = [];
	failRemove?: (key: string) => boolean;
	async head(key: string, signal: AbortSignal) { signal.throwIfAborted(); const bytes = this.objects.get(key); return bytes ? { size: bytes.length, etag: createHash("sha256").update(bytes).digest("hex") } : undefined; }
	async remove(key: string, signal: AbortSignal) { signal.throwIfAborted(); if (this.failRemove?.(key)) throw new Error("Simulated delete failure"); this.removed.push(key); this.objects.delete(key); }
	async upload(key: string, path: string, signal: AbortSignal, progress?: (bytes: number) => void) {
		signal.throwIfAborted();
		if (this.fail?.(key)) throw new Error("Simulated upload failure");
		const bytes = await readFile(path); this.objects.set(key, bytes); this.uploads.push(key); progress?.(bytes.length);
	}
	async download(key: string, path: string, signal: AbortSignal, limit: number, progress?: (bytes: number) => void) {
		signal.throwIfAborted(); const bytes = this.objects.get(key);
		if (!bytes) throw new Error("Object missing");
		if (bytes.length > limit) throw new Error("Object exceeds limit");
		await writeFile(path, bytes); progress?.(bytes.length); this.afterDownload?.(key);
	}
	async *list(prefix: string, signal: AbortSignal) { for (const key of this.objects.keys()) { signal.throwIfAborted(); if (key.startsWith(prefix)) yield key; } }
}
const signal = () => new AbortController().signal;
async function put(root: string, path: string, content: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
async function workspace() {
	const root = await mkdtemp(join(tmpdir(), "loom-cloud-test-"));
	await put(root, "notes/one.md", "hello backup");
	await put(root, ".loom/agents/memory/MEMORY.md", "remember this");
	await put(root, ".loom/agents/command-allows/command-allows.json", "local permissions");
	await put(root, ".loom/thumbnails/a.webp", "cache");
	await mkdir(join(root, "empty"));
	return root;
}

test("real SQLite, graph and durable chat round-trip preserves IDs, properties, relations and cwd", { timeout: 40_000 }, async () => {
	const root = await workspace(), parent = await mkdtemp(join(tmpdir(), "loom-cloud-restore-"));
	const core = new LocalCore(), store = new MemoryStore();
	const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
	const chat = new ChatService({ models, chatDefault: { provider: faux.models[0].provider, modelId: faux.models[0].id, thinkingLevel: "off" } });
	try {
		await put(root, "two.md", "second file");
		const original = await core.openLibrary(root);
		const one = original.assets.find((asset) => asset.relativePath === "notes/one.md")!, two = original.assets.find((asset) => asset.relativePath === "two.md")!;
		await core.setFavorite(one.assetId, true); await core.addAssetTag(one.assetId, "travel");
		const property = await core.createProperty("Location", "text");
		await core.setAssetProperty(one.assetId, property.propertyId, "Shanghai");
		const relation = await core.createRelation(one.assetId, two.assetId, "reference");
		await chat.openLibrary(root);
		const session = await chat.createSession();
		faux.setResponses([fauxAssistantMessage("saved answer")]);
		await chat.waitForTurn(await (await chat.prepareTurn(session.id, "remember the trip")).submit());
		await (await chat.conversation(session.id)).configure({ cwd: join(root, "notes") }, context);
		await chat.close(); await core.close();
		const snapshot = await captureSnapshot(root, signal());
		const record = await updateMirror(snapshot, store, "first computer", signal(), () => {});
		assert.deepEqual(await listCloudLibraries(store, signal()), [record]);
		const restored = await restoreMirror(record.libraryId, parent, store, signal(), () => {});
		assert.equal(await readFile(join(restored, "notes/one.md"), "utf8"), "hello backup");
		assert.equal(await readFile(join(restored, ".loom/agents/memory/MEMORY.md"), "utf8"), "remember this");
		await assert.rejects(stat(join(restored, ".loom/agents/command-allows/command-allows.json")), { code: "ENOENT" });
		assert.equal((await stat(join(restored, "empty"))).isDirectory(), true);
		const reopened = await core.openLibrary(restored);
		assert.equal(reopened.assets.find((asset) => asset.relativePath === "notes/one.md")!.assetId, one.assetId);
		assert.ok(reopened.favoriteAssetIds.includes(one.assetId));
		assert.deepEqual(await core.listTagUsage(), [{ name: "travel", count: 1 }]);
		assert.ok((await core.getPropertySnapshot()).values.some((row) => row.assetId === one.assetId && row.value === "Shanghai"));
		assert.ok((await core.listGraphRelations()).some((row) => row.relationId === relation.relationId));
		await chat.openLibrary(restored);
		assert.ok(JSON.stringify(await chat.getSession(session.id)).includes("saved answer"));
		assert.equal((await (await chat.conversation(session.id)).agent(context)).cwd, join(restored, "notes"));
		assert.equal(await readRestoreMarker(restored), undefined);
	} finally { await chat.close(); await core.close(); await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});

test("latest mirrors retain paths, skip unchanged uploads and remove files only in their own library", async () => {
	const root = await workspace(), other = await workspace(); const store = new MemoryStore();
	try {
		const first = await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		const secondLibrary = await updateMirror(await captureSnapshot(other, signal()), store, "other device", signal(), () => {});
		const base = mirrorRoot(first.libraryId), otherBase = mirrorRoot(secondLibrary.libraryId);
		assert.equal(store.objects.get(`${base}notes/one.md`)!.toString(), "hello backup");
		assert.equal(store.objects.get(`${base}empty/`)!.length, 0);
		const rawUploads = () => store.uploads.filter((key) => key.startsWith(base) && !key.endsWith("/") && key !== mirrorManifestKey(first.libraryId)).length;
		const count = rawUploads(), objectCount = store.objects.size;
		await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		assert.equal(rawUploads(), count, "unchanged content is not uploaded again");
		assert.equal(store.objects.size, objectCount, "another update creates no history objects");
		assert.equal((await listCloudLibraries(store, signal())).length, 2);
		// Editing a cloud file is detected through its ETag, even when the local file is unchanged.
		store.objects.set(`${base}notes/one.md`, Buffer.from("remote edit"));
		await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		assert.equal(store.objects.get(`${base}notes/one.md`)!.toString(), "hello backup");
		await rm(join(root, "notes/one.md")); await rm(join(root, "empty"), { recursive: true });
		await put(root, "renamed.md", "new content");
		await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		assert.equal(store.objects.has(`${base}notes/one.md`), false);
		assert.equal(store.objects.has(`${base}empty/`), false);
		assert.equal(store.objects.get(`${base}renamed.md`)!.toString(), "new content");
		assert.equal(store.objects.get(`${otherBase}notes/one.md`)!.toString(), "hello backup");
		assert.ok(store.removed.every((key) => key.startsWith(base)));
		const size = store.objects.size;
		for (const text of ["one", "two", "three"]) {
			await writeFile(join(root, "renamed.md"), text);
			await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
			assert.equal(store.objects.size, size);
		}
		assert.equal((await listCloudLibraries(store, signal())).length, 2);
	} finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test("interrupted updates withhold restore, defer deletions and repair overwritten bytes on retry", async () => {
	const root = await workspace(), parent = await mkdtemp(join(tmpdir(), "loom-mirror-retry-")); const store = new MemoryStore();
	try {
		await put(root, "00-first.md", "original"); await put(root, "deleted.md", "keep until uploads succeed");
		const first = await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		const base = mirrorRoot(first.libraryId);
		await writeFile(join(root, "00-first.md"), "changed"); await writeFile(join(root, "notes/one.md"), "changed too"); await rm(join(root, "deleted.md"));
		store.fail = (key) => key === `${base}notes/one.md`;
		await assert.rejects(updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {}), /Simulated/);
		assert.equal(store.objects.get(`${base}00-first.md`)!.toString(), "changed");
		assert.equal(store.objects.has(`${base}deleted.md`), true, "a failed upload must not start deletions");
		assert.equal((await listCloudLibraries(store, signal()))[0]!.state, "updating");
		await assert.rejects(restoreMirror(first.libraryId, parent, store, signal(), () => {}), /incomplete/);
		assert.deepEqual(await readdir(parent), []);
		// Reverting locally to the old hash must repair bytes changed by the failed attempt.
		await writeFile(join(root, "00-first.md"), "original"); store.fail = undefined;
		store.failRemove = (key) => key === `${base}deleted.md`;
		await assert.rejects(updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {}), /delete failure/);
		assert.equal((await listCloudLibraries(store, signal()))[0]!.state, "updating");
		store.failRemove = undefined;
		const ready = await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		assert.equal(ready.state, "ready"); assert.equal(store.objects.has(`${base}deleted.md`), false);
		assert.equal(store.objects.get(`${base}00-first.md`)!.toString(), "original");
		const restored = await restoreMirror(first.libraryId, parent, store, signal(), () => {});
		assert.equal(await readFile(join(restored, "00-first.md"), "utf8"), "original");
		const snapshot = await captureSnapshot(root, signal()); await writeFile(join(root, "notes/one.md"), "changed after capture");
		await assert.rejects(updateMirror(snapshot, store, "device", signal(), () => {}), /File changed/);
		await assert.rejects(stat(snapshot.temporary), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});

test("restored running tasks and queued inputs are cancelled before any model call resumes", { timeout: 15_000 }, async () => {
	const root = await workspace(), parent = await mkdtemp(join(tmpdir(), "loom-cloud-running-"));
	const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
	const model = { provider: faux.models[0].provider, modelId: faux.models[0].id };
	let owner: LibraryRuntime | undefined;
	const chat = new ChatService({ models, chatDefault: { ...model, thinkingLevel: "off" } });
	try {
		owner = await LibraryRuntime.open(root, { models, agent: { model } }, context);
		const conversation = await owner.createConversation({}, context);
		const entered = Promise.withResolvers<void>();
		faux.setResponses([async (_messages, options) => {
			entered.resolve();
			const signal = options!.signal!;
			await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
			return fauxAssistantMessage("interrupted");
		}]);
		await conversation.submit({ type: "input", content: "interrupted request" }, context);
		await entered.promise;
		await conversation.submit({ type: "input", content: "queued input", whenBusy: "followUp" }, context);
		await owner.close(context); owner = undefined;
		const before = faux.state.callCount;
		const store = new MemoryStore();
		const record = await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		const restored = await restoreMirror(record.libraryId, parent, store, signal(), () => {});
		await chat.openLibrary(restored);
		await chat.requireRuntime().harness.waitForIdle(context);
		assert.equal(faux.state.callCount, before, "restoring must not restart old paid model requests");
		assert.equal((await chat.requireRuntime().harness.inspect(context)).submissions.length, 0);
		// New work remains possible after recovery.
		faux.setResponses([fauxAssistantMessage("new answer")]);
		const newSession = await chat.createSession();
		assert.equal((await chat.waitForTurn(await (await chat.prepareTurn(newSession.id, "new input")).submit())).status, "done");
	} finally { await owner?.close(context); await chat.close(); await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});

test("deletion rejects a listing outside this library and restore rejects a concurrent update", async () => {
	const root = await workspace(), parent = await mkdtemp(join(tmpdir(), "loom-mirror-guards-")); const store = new MemoryStore();
	try {
		const ready = await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		const unrelated = "unrelated/keep.txt"; store.objects.set(unrelated, Buffer.from("keep"));
		const originalList = store.list.bind(store);
		store.list = async function* (prefix, signal) { if (prefix === mirrorRoot(ready.libraryId)) yield unrelated; yield* originalList(prefix, signal); };
		await assert.rejects(updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {}), /outside the current cloud library/);
		assert.equal(store.objects.get(unrelated)!.toString(), "keep");
		assert.ok(!store.removed.includes(unrelated));
		for (const path of ["../outside", "a/../../outside", "a\\..\\outside"]) {
			const unsafe = `${mirrorRoot(ready.libraryId)}${path}`;
			store.list = async function* (prefix, signal) { if (prefix === mirrorRoot(ready.libraryId)) yield unsafe; yield* originalList(prefix, signal); };
			await assert.rejects(updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {}), /Unsafe path/);
			assert.ok(!store.removed.includes(unsafe));
		}
		store.list = originalList;
		const latest = await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		store.afterDownload = (key) => {
			if (key === `${mirrorRoot(ready.libraryId)}notes/one.md`) store.objects.set(libraryCatalogKey(ready.libraryId), Buffer.from(JSON.stringify({ ...latest, state: "updating" })));
		};
		await assert.rejects(restoreMirror(ready.libraryId, parent, store, signal(), () => {}), /changed on another device/);
		assert.deepEqual(await readdir(parent), []);
	} finally { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});

test("restore verifies file hashes, rejects untrusted paths and cleans failed/cancelled downloads", async () => {
	const root = await workspace(), parent = await mkdtemp(join(tmpdir(), "loom-cloud-invalid-"));
	const store = new MemoryStore();
	try {
		const record = await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), () => {});
		const manifest: MirrorManifest = JSON.parse(store.objects.get(mirrorManifestKey(record.libraryId))!.toString());
		const file = manifest.files.find((f) => f.path === "notes/one.md")!;
		store.objects.set(`${mirrorRoot(record.libraryId)}${file.path}`, Buffer.from("bad checksum"));
		await assert.rejects(restoreMirror(record.libraryId, parent, store, signal(), () => {}), /checksum/);
		assert.deepEqual(await readdir(parent), []);
		for (const path of ["../outside", "/absolute", "C:/Windows/win.ini", "a\\..\\outside", ".loom/agents/command-allows/allow.json", ".loom/backup/restore.json"]) {
			assert.throws(() => validateBackupPath(path));
		}
		for (const path of ["AUX.txt", "a:stream", "folder/trailing."]) assert.throws(() => validateBackupPath(path, true));
		manifest.files[0]!.path = "../outside";
		const bytes = Buffer.from(JSON.stringify(manifest)), hash = createHash("sha256").update(bytes).digest("hex");
		store.objects.set(mirrorManifestKey(record.libraryId), bytes);
		store.objects.set(libraryCatalogKey(record.libraryId), Buffer.from(JSON.stringify({ ...record, manifestHash: hash })));
		await assert.rejects(restoreMirror(record.libraryId, parent, store, signal(), () => {}), /Unsafe path/);
		const abort = new AbortController(); abort.abort();
		await assert.rejects(restoreMirror(record.libraryId, parent, store, abort.signal, () => {}));
		assert.deepEqual(await readdir(parent), []);
		assert.equal(relocatedCwd("C:\\Users\\me\\Library\\Notes", "C:\\Users\\me\\Library", "/new/library"), join("/new/library", "Notes"));
		assert.equal(relocatedCwd("/old/library-other", "/old/library", "/new"), "/new");
	} finally { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});

test("links are rejected instead of uploading files outside the library", { skip: process.platform === "win32" }, async () => {
	const root = await workspace();
	try { await symlink(tmpdir(), join(root, "link")); await assert.rejects(captureSnapshot(root, signal()), /does not support links/); }
	finally { await rm(root, { recursive: true, force: true }); }
});

test("COS settings encrypt credentials, preserve them on edits and never return secrets in views", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-cloud-config-"));
	const path = join(directory, "cloud.json"), cipher = testChatCipher();
	const config = { provider: "cos" as const, bucket: "loom-1250000000", region: "ap-shanghai", prefix: "loom/v1", credentials: { secretId: "private-id", secretKey: "private-key" } };
	try {
		const store = new CloudConfigStore(path, cipher);
		await store.save(config);
		assert.deepEqual((await new CloudConfigStore(path, cipher).configuration()).credentials, config.credentials);
		assert.ok(!(await readFile(path, "utf8")).includes("private-"));
		assert.ok(!JSON.stringify(await store.view()).includes("private-"));
		await store.save({ ...config, prefix: "other/v1", credentials: { secretId: "", secretKey: "" } });
		assert.equal((await store.load()).credentials.secretKey, "private-key");
		await assert.rejects(new CloudConfigStore(path, { ...cipher, available: () => false }).save(config), /unavailable/);
		await assert.rejects(store.save({ ...config, bucket: "no-appid" }), /APPID/);
		await assert.rejects(store.save({ ...config, credentials: { secretId: "private-id", secretKey: "" } }), /both/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("controller serializes jobs, tests read/write/delete access, cancels safely and restores with no original root", async () => {
	const root = await workspace(), parent = await mkdtemp(join(tmpdir(), "loom-cloud-controller-"));
	const store = new MemoryStore();
	const settings = new CloudConfigStore(join(parent, "settings.json"), testChatCipher());
	await settings.save({ provider: "cos", bucket: "loom-1250000000", region: "ap-shanghai", prefix: "loom/v1", credentials: { secretId: "id", secretKey: "key" } });
	let restoredPath: string | undefined;
	const events: unknown[] = [];
	const controller = new CloudBackupController(settings, { capture: (signal) => captureSnapshot(root, signal), pickRestoreParent: async () => parent, openRestored: async (path) => { restoredPath = path; } }, (view) => events.push(view), () => store);
	async function wait() {
		const deadline = Date.now() + 5000;
		while ((await controller.view()).job?.status === "running") { if (Date.now() > deadline) throw new Error("Cloud test timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
		return (await controller.view()).job!;
	}
	try {
		assert.deepEqual((await controller.configuration()).credentials, { secretId: "id", secretKey: "key" });
		await controller.start("test"); await assert.rejects(controller.start("test"), /already running/);
		assert.equal((await wait()).status, "completed");
		await controller.start("backup"); assert.equal((await wait()).status, "completed");
		// A copy with no obsolete objects can succeed even when deletion is forbidden.
		store.failRemove = () => true;
		await controller.start("backup"); assert.equal((await wait()).status, "completed");
		await controller.start("test");
		const denied = await wait();
		assert.equal(denied.status, "failed"); assert.match(denied.error!, /delete failure/);
		store.failRemove = undefined;
		const record: CloudLibrary = (await controller.view()).libraries[0]!;
		await controller.start("restore", record.libraryId); assert.equal((await wait()).status, "completed");
		await controller.openRestored(); assert.ok(restoredPath);
		await controller.start("backup"); controller.cancel(); assert.equal((await wait()).status, "cancelled");
		assert.ok(!JSON.stringify(events).includes('"credentials":'), "job events must not broadcast the editing form's credentials");
	} finally { await controller.close(); await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});
