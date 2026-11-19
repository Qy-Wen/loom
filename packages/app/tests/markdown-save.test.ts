import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { MarkdownSave, type MarkdownFiles } from "../src/renderer/workbench/preview/markdown-save.ts";
import { flushPendingSaves, removePendingSave } from "../src/renderer/workbench/pending-saves.ts";
import type { MarkdownSnapshot } from "../src/shared/markdown-file.ts";

let dirtyCalls: boolean[];

beforeEach(() => {
	dirtyCalls = [];
	(globalThis as { window?: unknown }).window = { loom: { setCanvasDirty: (dirty: boolean) => dirtyCalls.push(dirty) } };
});
// A save left unsaved by a test would keep the shared list non-empty and hide the next test's first signal.
afterEach(() => {
	for (const save of opened.splice(0)) { save.dispose(); removePendingSave(save); }
	delete (globalThis as { window?: unknown }).window;
});

const opened: MarkdownSave[] = [];
class TrackedSave extends MarkdownSave {
	constructor(...args: ConstructorParameters<typeof MarkdownSave>) {
		super(...args);
		opened.push(this);
	}
}

/** A file on a fake disk. `disk` is what is stored; every save checks the revision like the real store. */
function fakeDisk(text: string) {
	let version = 1;
	const disk = { text, revision: `r${version}`, saves: [] as string[], failNext: false };
	const files: MarkdownFiles = {
		async read() { return { text: disk.text, revision: disk.revision, byteLength: Buffer.byteLength(disk.text) }; },
		async save(_id, next, revision) {
			if (disk.failNext) { disk.failNext = false; throw new Error("disk full"); }
			if (revision !== disk.revision) return { status: "conflict" };
			disk.text = next;
			disk.revision = `r${++version}`;
			disk.saves.push(next);
			return { status: "saved", snapshot: { text: next, revision: disk.revision, byteLength: Buffer.byteLength(next) } };
		},
	};
	const snapshot = (): MarkdownSnapshot => ({ text: disk.text, revision: disk.revision, byteLength: Buffer.byteLength(disk.text) });
	const changeOutside = (next: string) => { disk.text = next; disk.revision = `r${++version}`; };
	return { disk, files, snapshot, changeOutside };
}

test("typing saves once after a pause, and only the latest text", async () => {
	const { disk, files, snapshot } = fakeDisk("a");
	const save = new TrackedSave("id", snapshot(), files, 20);
	save.edit("ab");
	save.edit("abc");
	assert.equal(save.state, "dirty");
	assert.deepEqual(disk.saves, []);
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.deepEqual(disk.saves, ["abc"]);
	assert.equal(save.state, "saved");
	assert.equal(save.dirty, false);
});

test("text edited while a save is running is saved right after it", async () => {
	const { disk, snapshot } = fakeDisk("a");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const base = fakeDisk("a");
	const files: MarkdownFiles = {
		read: base.files.read,
		async save(id, text, revision) { if (!base.disk.saves.length) await gate; return base.files.save(id, text, revision); },
	};
	void disk; void snapshot;
	const save = new TrackedSave("id", base.snapshot(), files, 1000);
	save.edit("one");
	const first = save.flush();
	save.edit("one two");
	release();
	await first;
	await save.flush();
	assert.deepEqual(base.disk.saves, ["one", "one two"]);
	assert.equal(save.state, "saved");
});

test("going back to the saved text writes nothing", async () => {
	const { disk, files, snapshot } = fakeDisk("same");
	const save = new TrackedSave("id", snapshot(), files, 20);
	save.edit("same!");
	save.edit("same");
	assert.equal(save.state, "saved");
	await save.flush();
	assert.deepEqual(disk.saves, []);
	assert.deepEqual(dirtyCalls, [true, false]);
});

test("the window is told about unsaved text, and flushPendingSaves writes it", async () => {
	const { disk, files, snapshot } = fakeDisk("a");
	const save = new TrackedSave("id", snapshot(), files, 60_000);
	save.edit("b");
	assert.deepEqual(dirtyCalls, [true]);
	await flushPendingSaves();
	assert.deepEqual(disk.saves, ["b"]);
	assert.deepEqual(dirtyCalls, [true, false]);
	save.dispose();
});

test("a file changed outside with nothing unsaved is taken in silently", () => {
	const { files, snapshot, changeOutside } = fakeDisk("old");
	const save = new TrackedSave("id", snapshot(), files, 20);
	changeOutside("new");
	assert.equal(save.external(snapshot()), true);
	assert.equal(save.text, "new");
	assert.equal(save.state, "saved");
	assert.equal(save.external(snapshot()), false);
});

test("a file changed outside while there are unsaved edits is left alone until the save finds the conflict", async () => {
	const { disk, files, snapshot, changeOutside } = fakeDisk("old");
	const save = new TrackedSave("id", snapshot(), files, 60_000);
	save.edit("mine");
	changeOutside("theirs");
	assert.equal(save.external(snapshot()), false);
	assert.equal(save.text, "mine");
	await assert.rejects(save.flush(), /modified on disk/);
	assert.equal(save.state, "conflict");
	assert.equal(disk.text, "theirs");
	// Typing on keeps the text and does not try to save again.
	save.edit("mine more");
	assert.equal(save.state, "conflict");
	assert.deepEqual(dirtyCalls, [true]);
	save.dispose();
});

test("Overwrite writes the editor's text over the outside change", async () => {
	const { disk, files, snapshot, changeOutside } = fakeDisk("old");
	const save = new TrackedSave("id", snapshot(), files, 60_000);
	save.edit("mine");
	changeOutside("theirs");
	await assert.rejects(save.flush());
	await save.overwrite();
	assert.equal(disk.text, "mine");
	assert.equal(save.state, "saved");
	assert.deepEqual(dirtyCalls, [true, false]);
});

test("Reload drops the editor's text and takes the file as it is", async () => {
	const { files, snapshot, changeOutside } = fakeDisk("old");
	const save = new TrackedSave("id", snapshot(), files, 60_000);
	save.edit("mine");
	changeOutside("theirs");
	await assert.rejects(save.flush());
	await save.reload();
	assert.equal(save.text, "theirs");
	assert.equal(save.state, "saved");
	assert.equal(save.dirty, false);
	assert.deepEqual(dirtyCalls, [true, false]);
});

test("a failed write keeps the text, reports the error and can be retried", async () => {
	const { disk, files, snapshot } = fakeDisk("a");
	const save = new TrackedSave("id", snapshot(), files, 60_000);
	save.edit("b");
	disk.failNext = true;
	await assert.rejects(save.flush(), /disk full/);
	assert.equal(save.state, "error");
	assert.equal(save.error, "disk full");
	assert.equal(save.dirty, true);
	await save.flush();
	assert.equal(disk.text, "b");
	assert.equal(save.state, "saved");
	assert.equal(save.error, null);
});

test("the size tier follows adopted and saved snapshots, not outside changes while dirty", async () => {
	const { files, snapshot, changeOutside } = fakeDisk("小");
	const save = new TrackedSave("id", snapshot(), files, 60_000);
	assert.equal(save.byteLength, 3);
	save.edit("小笔记");
	await save.flush();
	assert.equal(save.byteLength, 9);
	changeOutside("x".repeat(20));
	assert.equal(save.external(snapshot()), true);
	assert.equal(save.byteLength, 20);
	save.edit("unsaved");
	changeOutside("x".repeat(40));
	assert.equal(save.external(snapshot()), false);
	assert.equal(save.byteLength, 20);
	await assert.rejects(save.flush());
	await save.reload();
	assert.equal(save.byteLength, 40);
	assert.equal(save.text.length, 40);
});
