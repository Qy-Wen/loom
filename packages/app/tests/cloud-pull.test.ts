import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { captureSnapshot, type Snapshot } from "../src/main/cloud-backup/snapshot.ts";
import { updateMirror, libraryCatalogKey, mirrorRoot, type MirrorManifest } from "../src/main/cloud-backup/mirror.ts";
import { planPull, resolvePull, SyncBaselines, type PullPlan } from "../src/main/cloud-backup/pull-plan.ts";
import { installPull, recoverPull } from "../src/main/cloud-backup/pull-install.ts";
import { CloudConfigStore } from "../src/main/cloud-backup/config.ts";
import { CloudBackupController } from "../src/main/cloud-backup/controller.ts";
import type { CloudPullChoice } from "../src/shared/cloud-backup.ts";
import { MemoryStore } from "./fixtures/cloud-store.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";

const config = { provider: "cos" as const, bucket: "loom-1250000000", region: "ap-shanghai" };
const signal = () => new AbortController().signal;
async function put(root: string, path: string, text: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
async function setup() {
	const parent = await mkdtemp(join(tmpdir(), "loom-pull-test-")), local = join(parent, "local"), remote = join(parent, "remote");
	for (const path of ["remote.txt", "local.txt", "conflict.txt"]) await put(local, path, "base");
	await put(local, ".loom/agents/memory/MEMORY.md", "base memory"); await put(local, ".loom/agents/command-allows/private.json", "local permissions");
	await put(local, ".loom/metadata-db/database", "base db");
	const store = new MemoryStore(), baselines = new SyncBaselines(join(parent, "baseline"));
	let initial!: MirrorManifest;
	await updateMirror(await captureSnapshot(local, signal()), store, "A", signal(), () => {}, undefined, (manifest) => { initial = manifest; });
	await baselines.save(config, initial, local); await cp(local, remote, { recursive: true });
	let snapshot: Snapshot | undefined;
	return { parent, local, remote, store, initial, baselines,
		async publish() { await updateMirror(await captureSnapshot(remote, signal()), store, "B", signal(), () => {}); },
		async preview(firstSync = false) {
			if (snapshot) await rm(snapshot.temporary, { recursive: true, force: true });
			snapshot = await captureSnapshot(local, signal());
			return { snapshot, plan: await planPull(snapshot, store, firstSync ? undefined : await baselines.read(config, snapshot.libraryId, local), signal(), () => {}) };
		},
		async close() { if (snapshot) await rm(snapshot.temporary, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); },
	};
}
function allChoices(plan: PullPlan, choice: CloudPullChoice) { return Object.fromEntries(plan.preview.changes.filter((change) => change.conflict).map((change) => [change.id, choice])); }

test("three-way pull distinguishes edits, additions and grouped metadata conflicts", async () => {
	const f = await setup();
	try {
		await put(f.local, "local.txt", "local edit"); await put(f.local, "conflict.txt", "local edit"); await put(f.local, "new-local.txt", "new");
		await put(f.remote, "remote.txt", "remote edit"); await put(f.remote, "conflict.txt", "remote edit"); await put(f.remote, "new-remote.txt", "new");
		await put(f.remote, ".loom/agents/memory/MEMORY.md", "remote memory"); await put(f.local, ".loom/metadata-db/database", "local db"); await f.publish();
		const { plan } = await f.preview(), byPath = new Map(plan.preview.changes.map((change) => [change.path, change]));
		assert.equal(byPath.get("local.txt")?.choice, "local"); assert.equal(byPath.get("remote.txt")?.choice, "remote");
		assert.equal(byPath.get("new-local.txt")?.choice, "local"); assert.equal(byPath.get("new-remote.txt")?.choice, "remote");
		assert.equal(byPath.get("conflict.txt")?.conflict, true);
		assert.equal(plan.preview.changes.filter((change) => change.type === "metadata").length, 1);
		assert.equal(plan.preview.changes.find((change) => change.type === "metadata")?.conflict, true);
		assert.throws(() => resolvePull(plan, {}), /every conflict/); assert.throws(() => resolvePull(plan, { extra: "remote" }), /Invalid conflict choice/); assert.throws(() => resolvePull(plan, []), /Choose how/);
		const selection = resolvePull(plan, allChoices(plan, "local"));
		assert.ok(selection.remote.some((node) => node.path === "remote.txt")); assert.ok(!selection.remote.some((node) => node.path === "conflict.txt")); assert.equal(selection.metadata, false);
		const unknown = (await f.preview(true)).plan;
		assert.equal(unknown.preview.firstSync, true); assert.equal(unknown.preview.changes.find((change) => change.path === "local.txt")?.conflict, true);
		assert.equal(unknown.preview.changes.find((change) => change.path === "new-local.txt")?.conflict, true); assert.equal(unknown.preview.changes.find((change) => change.path === "new-remote.txt")?.choice, "remote");
	} finally { await f.close(); }
});

test("pull updates the same folder, downloads changed bytes only and retains private settings and chosen local changes", async () => {
	const f = await setup();
	try {
		await put(f.local, "local.txt", "local edit"); await put(f.local, "conflict.txt", "local choice");
		await put(f.remote, "remote.txt", "remote edit"); await put(f.remote, "conflict.txt", "cloud choice"); await rm(join(f.remote, "local.txt"));
		await put(f.remote, ".loom/agents/memory/MEMORY.md", "remote memory"); await put(f.remote, ".loom/metadata-db/database", "remote db");
		await put(f.remote, ".loom/agents/command-allows/private.json", "remote permissions"); await mkdir(join(f.remote, "empty")); await f.publish();
		const { snapshot, plan } = await f.preview(), downloads: string[] = []; f.store.afterDownload = (key) => { downloads.push(key); };
		const result = await installPull(snapshot, plan, allChoices(plan, "local"), f.store, signal(), () => {}); assert.ok(result);
		assert.equal(await readFile(join(f.local, "local.txt"), "utf8"), "local edit"); assert.equal(await readFile(join(f.local, "conflict.txt"), "utf8"), "local choice"); assert.equal(await readFile(join(f.local, "remote.txt"), "utf8"), "remote edit");
		assert.equal(await readFile(join(f.local, ".loom/metadata-db/database"), "utf8"), "remote db"); assert.equal(await readFile(join(f.local, ".loom/agents/command-allows/private.json"), "utf8"), "local permissions");
		assert.equal(JSON.parse(await readFile(join(f.local, ".loom/backup/restore.json"), "utf8")).sourceRoot, await realpath(f.remote)); assert.deepEqual(await readdir(join(f.local, "empty")), []);
		assert.ok(!downloads.some((key) => key.endsWith("identity.json")), "reuse unchanged identity"); await result.finish();
		assert.ok(!(await readdir(f.parent)).some((name) => name.startsWith(".loom-pull-"))); await f.baselines.save(config, plan.manifest, f.local);
		assert.ok((await f.preview()).plan.preview.changes.every((change) => change.choice === "local"), "kept differences stay pending against new baseline");
	} finally { await f.close(); }
});

test("directory deletion, replacement and case renames resolve as whole subtrees", async () => {
	const f = await setup();
	try {
		await put(f.local, "Tree/a.txt", "base"); await put(f.local, "replace/a.txt", "base");
		await updateMirror(await captureSnapshot(f.local, signal()), f.store, "A", signal(), () => {}, undefined, (manifest) => { f.initial = manifest; });
		await f.baselines.save(config, f.initial, f.local); await rm(f.remote, { recursive: true }); await cp(f.local, f.remote, { recursive: true });
		await put(f.local, "Tree/a.txt", "local edit"); await rm(join(f.remote, "Tree"), { recursive: true });
		await rm(join(f.remote, "replace"), { recursive: true }); await put(f.remote, "replace", "now a file"); await f.publish();
		const { snapshot, plan } = await f.preview(), tree = plan.preview.changes.find((change) => change.path === "Tree")!;
		assert.equal(tree.type, "directory"); assert.equal(tree.conflict, true); assert.equal(tree.remoteExists, false); assert.equal(plan.preview.changes.find((change) => change.path === "replace")?.choice, "remote"); assert.ok(!plan.preview.changes.some((change) => change.path === "Tree/a.txt"));
		await (await installPull(snapshot, plan, allChoices(plan, "remote"), f.store, signal(), () => {}))!.finish();
		assert.ok(!(await readdir(f.local)).includes("Tree")); assert.equal(await readFile(join(f.local, "replace"), "utf8"), "now a file");
		await rename(join(f.remote, "replace"), join(f.remote, "REPLACE")); await f.publish(); const renamed = await f.preview();
		await (await installPull(renamed.snapshot, renamed.plan, allChoices(renamed.plan, "remote"), f.store, signal(), () => {}))!.finish();
		assert.ok((await readdir(f.local)).includes("REPLACE")); assert.ok(!(await readdir(f.local)).includes("replace"));
	} finally { await f.close(); }
});

for (const failure of ["checksum", "source edit", "cloud revision", "cancel", "link"] as const) test(`pull ${failure} failure leaves the original untouched`, { skip: failure === "link" && process.platform === "win32" }, async () => {
	const f = await setup();
	try {
		await put(f.remote, "remote.txt", "remote edit"); await f.publish(); const { snapshot, plan } = await f.preview(), abort = new AbortController(); const key = `${mirrorRoot(snapshot.libraryId)}remote.txt`;
		if (failure === "checksum") f.store.objects.set(key, Buffer.from("wrong bytes"));
		if (failure === "source edit") await put(f.local, "new-after-preview.txt", "external edit");
		if (failure === "link") await symlink(join(f.parent, "outside"), join(f.local, ".loom/private-link"));
		if (failure === "cloud revision") f.store.afterDownload = (download) => { if (download === key) f.store.objects.set(libraryCatalogKey(snapshot.libraryId), Buffer.from(JSON.stringify({ ...plan.library, revision: randomUUID() }))); };
		await assert.rejects(installPull(snapshot, plan, {}, f.store, abort.signal, (patch) => { if (failure === "cancel" && patch.phase === "download") abort.abort(); }));
		assert.equal(await readFile(join(f.local, "remote.txt"), "utf8"), "base"); assert.equal(await readFile(join(f.local, ".loom/metadata-db/database"), "utf8"), "base db"); assert.ok(!(await readdir(f.parent)).some((name) => name.startsWith(".loom-pull-")));
	} finally { await f.close(); }
});

for (const change of ["timestamps", "previewed file contents", "private file contents"] as const) {
	test(`Windows pull checks ${change} when only ctime differs`, { skip: process.platform !== "win32" }, async () => {
		const f = await setup();
		try {
			const tracked = join(f.local, "remote.txt");
			const privateFile = join(f.local, ".loom/agents/command-allows/private.json");
			const mtime = new Date("2024-01-01T00:00:00Z");
			for (const path of [tracked, privateFile]) await utimes(path, mtime, mtime);
			await put(f.remote, "remote.txt", "remote edit");
			await f.publish();
			const { snapshot, plan } = await f.preview();
			const changeFile = async (path: string, contents?: string) => {
				const before = await lstat(path);
				if (contents !== undefined) await writeFile(path, contents);
				await utimes(path, new Date("2024-01-02T00:00:00Z"), mtime);
				const after = await lstat(path);
				assert.equal(after.size, before.size);
				assert.equal(after.mtimeMs, before.mtimeMs);
				assert.equal(after.ino, before.ino);
				assert.notEqual(after.ctimeMs, before.ctimeMs);
			};
			if (change !== "private file contents") await changeFile(tracked, change === "previewed file contents" ? "edit" : undefined);
			const download = f.store.download.bind(f.store);
			f.store.download = async (...args) => {
				await download(...args);
				if (args[0] === `${mirrorRoot(snapshot.libraryId)}remote.txt`) {
					await changeFile(privateFile, change === "private file contents" ? "other permissions" : undefined);
				}
			};
			const result = installPull(snapshot, plan, {}, f.store, signal(), () => {});
			if (change === "timestamps") {
				await (await result)!.finish();
				assert.equal(await readFile(tracked, "utf8"), "remote edit");
				assert.equal(await readFile(privateFile, "utf8"), "local permissions");
			} else {
				await assert.rejects(result, /Local files changed/);
				assert.equal(await readFile(tracked, "utf8"), change === "previewed file contents" ? "edit" : "base");
				assert.equal(await readFile(privateFile, "utf8"), change === "private file contents" ? "other permissions" : "local permissions");
			}
		} finally { await f.close(); }
	});
}

test("rollback and crash recovery preserve original databases and retain an installed tree", async () => {
	for (const gap of [false, true]) {
		const f = await setup();
		try {
			await put(f.remote, "remote.txt", "remote edit"); await f.publish(); const { snapshot, plan } = await f.preview(); await installPull(snapshot, plan, {}, f.store, signal(), () => {});
			await put(f.local, ".loom/metadata-db/database", "new runtime wrote db");
			if (gap) { const journal = (await readdir(f.parent)).find((name) => name.startsWith(".loom-pull-") && name.endsWith(".json"))!; const record = JSON.parse(await readFile(join(f.parent, journal), "utf8")); await rename(f.local, join(f.parent, record.directory, "new")); }
			const saved = await recoverPull(f.local);
			assert.equal(await readFile(join(f.local, "remote.txt"), "utf8"), "base"); assert.equal(await readFile(join(f.local, ".loom/metadata-db/database"), "utf8"), "base db");
			if (!gap) { assert.ok(saved); assert.equal(await readFile(join(saved!, ".loom/metadata-db/database"), "utf8"), "new runtime wrote db"); } assert.equal(await recoverPull(f.local), undefined);
		} finally { await f.close(); }
	}
});

test("controller validates choices and reopens on cancellation", async () => {
	const f = await setup(), settings = new CloudConfigStore(join(f.parent, "settings.json"), testChatCipher()); await settings.save({ ...config, credentials: { secretId: "id", secretKey: "key" } });
	let paused = false;
	const controller = new CloudBackupController(settings, { capture: (signal) => captureSnapshot(f.local, signal), pickRestoreParent: async () => undefined, openRestored: async () => {}, updateCurrent: async (signal, action) => { paused = true; const snapshot = await captureSnapshot(f.local, signal); try { await (await action(snapshot))?.finish(); } finally { paused = false; await rm(snapshot.temporary, { recursive: true, force: true }); } } }, () => {}, () => f.store, join(f.parent, "state.json"));
	async function waitFor(predicate: () => Promise<boolean>) { const end = Date.now() + 5000; while (!await predicate()) { if (Date.now() > end) throw new Error("Cloud job did not settle"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
	try {
		await controller.openLibrary(f.local); await put(f.local, "conflict.txt", "local edit"); await put(f.remote, "conflict.txt", "remote edit"); await f.publish(); await controller.start("pull"); await waitFor(async () => !!(await controller.view()).pull);
		assert.equal(paused, true); const preview = (await controller.view()).pull!; assert.throws(() => controller.resolvePull("stale", {}), /no longer active/); assert.throws(() => controller.resolvePull(preview.id, {}), /every conflict/);
		controller.cancel(); await waitFor(async () => (await controller.view()).job?.status !== "running"); assert.equal(paused, false); assert.equal((await controller.view()).job?.status, "cancelled"); assert.equal(await readFile(join(f.local, "conflict.txt"), "utf8"), "local edit");
		await controller.start("pull"); await waitFor(async () => !!(await controller.view()).pull); const current = (await controller.view()).pull!; controller.resolvePull(current.id, Object.fromEntries(current.changes.filter((change) => change.conflict).map((change) => [change.id, "remote"])));
		await waitFor(async () => (await controller.view()).job?.status !== "running"); assert.equal((await controller.view()).job?.status, "completed", (await controller.view()).job?.error); assert.equal(await readFile(join(f.local, "conflict.txt"), "utf8"), "remote edit");
	} finally { await controller.close(); await f.close(); }
});


test("common baselines are isolated for two local folders with the same library identity", async () => {
	const f = await setup();
	try {
		assert.equal(await f.baselines.read(config, f.initial.library.libraryId, f.remote), undefined);
		const advanced = { ...f.initial, library: { ...f.initial.library, revision: randomUUID() } };
		await f.baselines.save(config, advanced, f.remote);
		assert.equal((await f.baselines.read(config, f.initial.library.libraryId, f.local))?.revision, f.initial.library.revision);
		assert.equal((await f.baselines.read(config, f.initial.library.libraryId, f.remote))?.revision, advanced.library.revision);
	} finally { await f.close(); }
});

test("a mismatched cloud identity is rejected even if the user would keep local metadata", async () => {
	const f = await setup();
	try {
		const path = ".loom/backup/identity.json", key = `${mirrorRoot(f.initial.library.libraryId)}${path}`;
		const bytes = Buffer.from(JSON.stringify({ id: randomUUID() })), hash = createHash("sha256").update(bytes).digest("hex");
		const manifest = structuredClone(f.initial), entry = manifest.files.find((file) => file.path === path)!;
		manifest.library.totalBytes += bytes.length - entry.size; Object.assign(entry, { size: bytes.length, hash, etag: hash });
		const json = Buffer.from(JSON.stringify(manifest)); f.store.objects.set(key, bytes);
		f.store.objects.set(`${mirrorRoot(manifest.library.libraryId)}.loom/backup/manifest.json`, json);
		f.store.objects.set(libraryCatalogKey(manifest.library.libraryId), Buffer.from(JSON.stringify({ ...manifest.library, state: "ready", manifestHash: createHash("sha256").update(json).digest("hex") })));
		await assert.rejects(f.preview(), /identity mismatch/);
		assert.equal(await readFile(join(f.local, "remote.txt"), "utf8"), "base");
	} finally { await f.close(); }
});
