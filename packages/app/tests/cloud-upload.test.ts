import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { captureSnapshot, stageSnapshotFile } from "../src/main/cloud-backup/snapshot.ts";
import { libraryCatalogKey, mirrorRoot, restoreMirror, updateMirror } from "../src/main/cloud-backup/mirror.ts";
import { uploadJournalPath } from "../src/main/cloud-backup/upload-journal.ts";
import { StagingBudget } from "../src/main/cloud-backup/upload-pool.ts";
import { MemoryStore } from "./fixtures/cloud-store.ts";

const signal = () => new AbortController().signal;
const config = { provider: "cos" as const, bucket: "test-1250000000", region: "ap-shanghai", prefix: "loom/v1" };
async function fixture() {
	const parent = await mkdtemp(join(tmpdir(), "loom-upload-")), root = join(parent, "library"); await mkdir(root);
	for (const path of ["a.txt", "b.txt", "c.txt", "deleted.txt"]) await writeFile(join(root, path), `original ${path}`);
	return { parent, root };
}

test("retry reuses completed files and baseline candidates, survives a torn log and rechecks source/remote contents", async () => {
	const { parent, root } = await fixture(), store = new MemoryStore();
	let resumeFile = "";
	async function update() {
		const snapshot = await captureSnapshot(root, signal()); snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
		resumeFile = uploadJournalPath(join(parent, "progress"), config, snapshot.libraryId);
		return updateMirror(snapshot, store, "device", signal(), () => {}, () => {}, () => {}, { resumeFile, concurrency: 1 });
	}
	try {
		const first = await update(), base = mirrorRoot(first.libraryId);
		await writeFile(join(root, "a.txt"), "changed a"); await writeFile(join(root, "b.txt"), "changed b"); await rm(join(root, "deleted.txt"));
		store.fail = (key) => key === `${base}b.txt`;
		await assert.rejects(update(), /Simulated upload failure/);
		assert.equal(store.objects.get(`${base}a.txt`)!.toString(), "changed a");
		assert.ok(store.objects.has(`${base}deleted.txt`), "deletion waits for every upload");
		await assert.rejects(restoreMirror(first.libraryId, parent, store, signal(), () => {}), /incomplete/);
		assert.ok((await stat(resumeFile)).size > 0);
		await appendFile(resumeFile, '{"path":');
		store.fail = undefined; store.uploads = [];
		await update();
		assert.ok(!store.uploads.includes(`${base}a.txt`), "a completed upload survives a new journal instance and torn final append");
		assert.ok(!store.uploads.includes(`${base}c.txt`), "unvisited baseline files remain reusable after failure");
		assert.ok(store.uploads.includes(`${base}b.txt`)); assert.ok(!store.objects.has(`${base}deleted.txt`));
		await assert.rejects(stat(resumeFile), { code: "ENOENT" });
		// A second failure has both local edits and an independently changed cloud object on retry.
		await writeFile(join(root, "a.txt"), "third a"); await writeFile(join(root, "b.txt"), "third b");
		store.fail = (key) => key === `${base}b.txt`; await assert.rejects(update(), /Simulated/);
		await writeFile(join(root, "a.txt"), "fourth a");
		store.objects.set(`${base}c.txt`, Buffer.from("cloud changed"));
		store.fail = undefined; store.uploads = []; await update();
		assert.ok(store.uploads.includes(`${base}a.txt`), "changed local bytes invalidate a completed checkpoint");
		assert.ok(store.uploads.includes(`${base}c.txt`), "a changed remote ETag invalidates a checkpoint");
		const restored = await restoreMirror(first.libraryId, parent, store, signal(), () => {});
		assert.equal(await readFile(join(restored, "a.txt"), "utf8"), "fourth a");
		assert.equal(await readFile(join(restored, "c.txt"), "utf8"), "original c.txt");
		// A new cloud revision cannot inherit another device's in-progress checkpoints.
		await writeFile(join(root, "a.txt"), "fifth a"); await writeFile(join(root, "b.txt"), "fifth b");
		store.fail = (key) => key === `${base}b.txt`; await assert.rejects(update(), /Simulated/);
		const key = libraryCatalogKey(first.libraryId), catalog = JSON.parse(store.objects.get(key)!.toString());
		store.objects.set(key, Buffer.from(JSON.stringify({ ...catalog, revision: randomUUID() })));
		store.fail = undefined; store.uploads = []; await update();
		assert.ok(store.uploads.includes(`${base}a.txt`), "a revision mismatch discards stale progress");
		assert.notEqual(uploadJournalPath(parent, config, first.libraryId), uploadJournalPath(parent, { ...config, prefix: "other" }, first.libraryId));
	} finally { await rm(parent, { recursive: true, force: true }); }
});

test("uploads overlap within the file limit, retain distinct staged bytes and report monotonic progress", async () => {
	const { parent, root } = await fixture(), store = new MemoryStore();
	const upload = store.upload.bind(store);
	let active = 0, peak = 0;
	const late: (() => void)[] = [], progress: { completedBytes: number; uploadedBytes?: number; skippedFiles?: number }[] = [];
	store.upload = async (key, path, transfer, onProgress) => {
		active++; peak = Math.max(peak, active);
		try { await delay(15, undefined, { signal: transfer }); await upload(key, path, transfer, onProgress); if (onProgress) late.push(() => onProgress(1)); }
		finally { active--; }
	};
	try {
		const snapshot = await captureSnapshot(root, signal()), total = snapshot.files.reduce((sum, file) => sum + file.size, 0);
		const ready = await updateMirror(snapshot, store, "device", signal(), (patch) => { if (patch.completedBytes !== undefined) progress.push({ completedBytes: patch.completedBytes, uploadedBytes: patch.uploadedBytes, skippedFiles: patch.skippedFiles }); });
		assert.ok(peak > 1 && peak <= 3); assert.equal(active, 0);
		assert.ok(progress.every((value, index) => value.completedBytes <= total && (!index || value.completedBytes >= progress[index - 1]!.completedBytes)));
		assert.equal(progress.at(-1)!.completedBytes, total);
		assert.equal(progress.at(-1)!.uploadedBytes, total);
		const reports = progress.length; late.forEach((callback) => callback()); assert.equal(progress.length, reports, "late provider callbacks cannot resurrect completed transfers");
		const restored = await restoreMirror(ready.libraryId, parent, store, signal(), () => {});
		for (const path of ["a.txt", "b.txt", "c.txt"]) assert.equal(await readFile(join(restored, path), "utf8"), `original ${path}`);
		await updateMirror(await captureSnapshot(root, signal()), store, "device", signal(), (patch) => { if (patch.uploadedBytes !== undefined) { assert.equal(patch.uploadedBytes, 0); } });
	} finally { await rm(parent, { recursive: true, force: true }); }
});

test("user cancellation retains completed progress, while a corrupted log falls back to verification from scratch", async () => {
	const { parent, root } = await fixture(), store = new MemoryStore();
	let cancel = true, resumeFile = "";
	const upload = store.upload.bind(store), abort = new AbortController();
	store.upload = async (...args) => { if (cancel && args[0].endsWith("/b.txt")) { abort.abort(); args[2].throwIfAborted(); } await upload(...args); };
	async function update(transfer = signal()) {
		const snapshot = await captureSnapshot(root, signal()); snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
		resumeFile = uploadJournalPath(join(parent, "progress"), config, snapshot.libraryId);
		return updateMirror(snapshot, store, "device", transfer, () => {}, () => {}, () => {}, { resumeFile, concurrency: 1 });
	}
	try {
		await assert.rejects(update(abort.signal), { name: "AbortError" });
		assert.ok((await stat(resumeFile)).size > 0);
		cancel = false; store.uploads = []; await update();
		assert.ok(!store.uploads.some((key) => key.endsWith("/a.txt")), "cancelled jobs keep their verified files");
		await writeFile(join(root, "a.txt"), "second a"); await writeFile(join(root, "b.txt"), "second b");
		store.fail = (key) => key.endsWith("/b.txt"); await assert.rejects(update(), /Simulated/);
		await writeFile(resumeFile, "corrupted\n");
		store.fail = undefined; store.uploads = []; await update();
		assert.ok(store.uploads.some((key) => key.endsWith("/a.txt")), "damaged progress is never trusted");
		await assert.rejects(stat(resumeFile), { code: "ENOENT" });
	} finally { await rm(parent, { recursive: true, force: true }); }
});

test("a growing source cannot exceed its declared staging allocation", async () => {
	const { parent, root } = await fixture(), original = fs.createReadStream;
	const snapshot = await captureSnapshot(root, signal()), file = snapshot.files.find((item) => item.path === "a.txt")!;
	const target = join(snapshot.temporary, "growing");
	fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
		const stream = original(...args);
		if (String(args[0]) === file.source) stream.once("open", () => fs.appendFileSync(file.source, Buffer.alloc(256 * 1024)));
		return stream;
	}) as typeof fs.createReadStream;
	syncBuiltinESMExports();
	try {
		await assert.rejects(stageSnapshotFile(file, target, signal()), /File changed/);
		assert.ok((await stat(target)).size <= file.size);
	} finally {
		fs.createReadStream = original; syncBuiltinESMExports();
		await rm(snapshot.temporary, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true });
	}
});

test("failure and cancellation settle every worker before deleting temporary files or remote objects", async () => {
	for (const cancel of [false, true]) {
		const { parent, root } = await fixture(), store = new MemoryStore(), abort = new AbortController();
		const upload = store.upload.bind(store); let active = 0;
		store.upload = async (key, path, transfer, progress) => {
			if (!key.endsWith(".txt")) return upload(key, path, transfer, progress);
			active++;
			try {
				if (key.endsWith("b.txt")) { await delay(5); if (cancel) abort.abort(); else throw new Error("connection lost"); }
				await delay(25); // Even a provider slow to acknowledge abort must settle before cleanup.
				await upload(key, path, transfer, progress);
			} finally { active--; }
		};
		try {
			const snapshot = await captureSnapshot(root, signal());
			await assert.rejects(updateMirror(snapshot, store, "device", abort.signal, () => {}));
			assert.equal(active, 0); assert.equal(store.removed.length, 0);
			await assert.rejects(stat(snapshot.temporary), { code: "ENOENT" });
		} finally { await rm(parent, { recursive: true, force: true }); }
	}
});

test("staging budget isolates oversized files and lets cancelled waiters release the queue", async () => {
	const budget = new StagingBudget(10), abort = new AbortController();
	const big = await budget.acquire(100, signal());
	const cancelled = budget.acquire(8, abort.signal), rejected = assert.rejects(cancelled, { name: "AbortError" });
	let admitted = false;
	const small = budget.acquire(2, signal()).then((release) => { admitted = true; return release; });
	await delay(5); assert.equal(admitted, false);
	abort.abort(); await rejected; assert.equal(admitted, false);
	big(); const releaseSmall = await small; assert.equal(admitted, true); releaseSmall();
	const nextBig = await budget.acquire(100, signal()); nextBig();
});
