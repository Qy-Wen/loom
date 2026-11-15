import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebContents } from "electron";
import type { PasteConflict } from "@loom/core";
import { pasteConflictResolver, resolvePasteConflict } from "../src/main/desktop/paste-conflicts.ts";

const conflict: PasteConflict = {
	sourcePath: "/library/from/note.md", destinationPath: "/library/to/note.md",
	sourceIsDirectory: false, destinationIsDirectory: false,
};

function renderer(id: number) {
	const messages: { id: number; conflict: PasteConflict | null }[] = [];
	const sender = { id, isDestroyed: () => false, send: (_channel: string, request: typeof messages[number]) => messages.push(request) } as unknown as WebContents;
	return { sender, messages };
}

test("paste answers belong to their renderer and Apply to All only lasts for one batch", async () => {
	const { sender, messages } = renderer(1);
	const controller = new AbortController();
	const resolve = pasteConflictResolver(sender, controller.signal);
	const first = resolve(conflict);
	const id = messages[0]!.id;
	resolvePasteConflict(2, id, "replace", true);
	resolvePasteConflict(1, id, "invalid" as "replace", true);
	resolvePasteConflict(1, id, "keep-both", true);
	assert.equal(await first, "keep-both");
	assert.equal(await resolve(conflict), "keep-both");
	assert.equal(messages.length, 1);
	const next = pasteConflictResolver(sender, controller.signal)(conflict);
	assert.equal(messages.length, 2);
	resolvePasteConflict(1, id, "replace", false);
	resolvePasteConflict(1, messages[1]!.id, "cancel", true);
	assert.equal(await next, "cancel");
});

test("aborting a pending paste closes its dialog and ignores late answers", async () => {
	const { sender, messages } = renderer(3);
	const controller = new AbortController();
	const resolve = pasteConflictResolver(sender, controller.signal);
	const result = resolve(conflict);
	const id = messages[0]!.id;
	controller.abort();
	assert.equal(await result, "cancel");
	assert.deepEqual(messages[1], { id, conflict: null });
	resolvePasteConflict(sender.id, id, "replace", true);
	assert.equal(await resolve(conflict), "cancel");
	assert.equal(messages.length, 2);
});
