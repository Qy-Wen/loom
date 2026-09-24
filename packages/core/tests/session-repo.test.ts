import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LocalCore } from "../src/local-core.ts";
import {
	DEFAULT_SESSION_TITLE,
	titleFromUserText,
	userMessageText,
} from "../src/model/session.ts";
import { JsonlSessionRepo, SessionOpenError } from "../src/sessions/repo.ts";

describe("JsonlSessionRepo", () => {
	it("creates, lists, appends, titles, and restores messages", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-sessions-"));
		try {
			const repo = new JsonlSessionRepo(root);
			const created = await repo.create();
			assert.equal(created.title, DEFAULT_SESSION_TITLE);
			assert.equal(created.status, "open");
			assert.deepEqual(created.messages, []);
			assert.equal(repo.isOpen(created.id), true);

			const files = await readdir(root);
			assert.equal(files.length, 1);
			assert.match(files[0] ?? "", new RegExp(`_${created.id}\\.jsonl$`));

			const user = { role: "user", content: "clip the hero shot please" };
			const assistant = { role: "assistant", content: "working" };
			await repo.appendMessages(created.id, [user, assistant]);
			await repo.setName(created.id, titleFromUserText(userMessageText(user) ?? ""));

			const listed = await repo.list();
			assert.equal(listed.length, 1);
			assert.equal(listed[0]?.id, created.id);
			assert.equal(listed[0]?.title, "clip the hero shot please");

			const loaded = await repo.get(created.id);
			assert.deepEqual(loaded.messages, [user, assistant]);
			assert.equal(loaded.title, "clip the hero shot please");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("archives, refuses delete while open, then deletes after close", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-sessions-del-"));
		try {
			const repo = new JsonlSessionRepo(root);
			const first = await repo.create();
			const second = await repo.create();
			assert.equal(repo.isOpen(first.id), true);
			assert.equal(repo.isOpen(second.id), true);

			await assert.rejects(() => repo.delete(first.id), SessionOpenError);

			await repo.setStatus(first.id, "archived");
			assert.equal(repo.isOpen(first.id), false);
			assert.equal((await repo.get(first.id)).status, "archived");

			await repo.setStatus(first.id, "open");
			assert.equal((await repo.get(first.id)).status, "open");
			assert.equal(repo.isOpen(first.id), true);

			repo.closeHandle(first.id);
			await repo.delete(first.id);
			assert.equal((await repo.list()).map((session) => session.id).includes(first.id), false);
			assert.equal((await repo.list()).length, 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("skips corrupt lines and files without a header", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-sessions-bad-"));
		try {
			await writeFile(join(root, "no-header.jsonl"), `${JSON.stringify({ kind: "name", name: "x", timestamp: 1 })}\n`);
			await writeFile(
				join(root, "2020-01-01T00-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
				[
					JSON.stringify({ v: 1, kind: "header", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", createdAt: 1 }),
					"not-json",
					JSON.stringify({ kind: "message", message: { role: "user", content: "hi" }, timestamp: 2 }),
					JSON.stringify({ kind: "message", message: { text: "no role" }, timestamp: 3 }),
				].join("\n"),
			);
			const repo = new JsonlSessionRepo(root);
			const list = await repo.list();
			assert.equal(list.length, 1);
			assert.equal((await repo.get("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).messages.length, 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("session titles", () => {
	it("builds a compact title from the first user text", () => {
		assert.equal(titleFromUserText("  clip   this  "), "clip this");
		assert.equal(titleFromUserText("x".repeat(50)).endsWith("…"), true);
		assert.equal(userMessageText({ role: "assistant", content: "no" }), undefined);
		assert.equal(userMessageText({ role: "user", content: [{ type: "text", text: "hello" }] }), "hello");
	});
});

describe("LocalCore sessions", () => {
	it("requires an open library and writes JSONL under .loom/sessions", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-core-sessions-"));
		const core = new LocalCore();
		try {
			await assert.rejects(() => core.listSessions(), /No library is open/);
			const snapshot = await core.openLibrary(root);
			const created = await core.createSession();
			const names = await readdir(join(root, ".loom", "sessions"));
			assert.equal(names.some((name) => name.includes(created.id)), true);
			assert.equal((await core.listSessions()).length, 1);
			assert.equal(snapshot.assets.some((asset) => asset.relativePath.includes(".loom")), false);
			assert.equal(
				(await core.getLibrarySnapshot()).assets.some((asset) => asset.relativePath.includes("sessions")),
				false,
			);

			const seen: string[][] = [];
			const stop = core.subscribeSessions((list) => seen.push(list.map((session) => session.title)));
			await core.setSessionName(created.id, "clip the hero shot");
			stop();
			assert.deepEqual(seen.at(-1), ["clip the hero shot"]);
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
