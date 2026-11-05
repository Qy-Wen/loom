import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { after, describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { MIGRATIONS, SCHEMA_VERSION, migrate, type Migration } from "../src/stores/schema.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";

const roots: string[] = [];
after(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function libraryPaths(): Promise<LibraryPaths> {
	const root = await mkdtemp(join(tmpdir(), "loom-schema-"));
	roots.push(root);
	return new LibraryPaths(root);
}

const asset: Asset = {
	assetId: "a1",
	relativePath: "notes/a.md",
	filename: "a.md",
	type: "text",
	size: 10,
	createdAt: 1,
	modifiedAt: 2,
};

function memoryDatabase(): Database.Database {
	return new Database(":memory:");
}

describe("schema versions", () => {
	it("stamps a new library with the current version", async () => {
		const paths = await libraryPaths();
		const store = new SqliteMetadataStore();
		await store.open(paths);
		await store.close();
		const database = new Database(paths.metadataDb);
		assert.equal(database.pragma("user_version", { simple: true }), SCHEMA_VERSION);
		database.close();
	});

	it("adopts a library made before versions existed without touching its rows", async () => {
		const paths = await libraryPaths();
		const first = new SqliteMetadataStore();
		await first.open(paths);
		await first.upsertAsset(asset);
		await first.addAssetTag("a1", "keep");
		await first.setFavorite("a1", true);
		await first.close();

		// A library from before the version number: same tables and rows, user_version 0.
		const raw = new Database(paths.metadataDb);
		raw.pragma("user_version = 0");
		raw.close();

		const second = new SqliteMetadataStore();
		await second.open(paths);
		assert.equal((await second.getAsset("a1"))?.relativePath, "notes/a.md");
		assert.deepEqual((await second.listTags()).map((tag) => tag.name), ["keep"]);
		assert.deepEqual(await second.listFavoriteIds(), ["a1"]);
		await second.close();

		const check = new Database(paths.metadataDb);
		assert.equal(check.pragma("user_version", { simple: true }), SCHEMA_VERSION);
		check.close();
	});

	it("refuses a library written by a newer Loom and leaves it unchanged", async () => {
		const paths = await libraryPaths();
		const first = new SqliteMetadataStore();
		await first.open(paths);
		await first.upsertAsset(asset);
		await first.close();
		const raw = new Database(paths.metadataDb);
		raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
		raw.close();

		const second = new SqliteMetadataStore();
		await assert.rejects(() => second.open(paths), /newer version of Loom/);

		const check = new Database(paths.metadataDb);
		assert.equal(check.pragma("user_version", { simple: true }), SCHEMA_VERSION + 1);
		assert.equal((check.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n, 1);
		check.close();
	});

	it("runs only the migrations a database has not seen", () => {
		const database = memoryDatabase();
		const ran: number[] = [];
		const list: Migration[] = [
			{ version: 1, up: (db) => { ran.push(1); db.exec("CREATE TABLE t (a TEXT)"); } },
			{ version: 2, up: (db) => { ran.push(2); db.exec("ALTER TABLE t ADD COLUMN b TEXT"); } },
		];
		migrate(database, list.slice(0, 1));
		assert.deepEqual(ran, [1]);
		migrate(database, list);
		assert.deepEqual(ran, [1, 2]);
		migrate(database, list);
		assert.deepEqual(ran, [1, 2], "a current database runs nothing");
		assert.equal(database.pragma("user_version", { simple: true }), 2);
		database.close();
	});

	it("rolls every pending migration back when one fails", () => {
		const database = memoryDatabase();
		migrate(database, [{ version: 1, up: (db) => db.exec("CREATE TABLE t (a TEXT)") }]);
		database.prepare("INSERT INTO t (a) VALUES ('kept')").run();
		const broken: Migration[] = [
			{ version: 1, up: () => {} },
			{ version: 2, up: (db) => db.exec("ALTER TABLE t ADD COLUMN b TEXT") },
			{ version: 3, up: () => { throw new Error("boom"); } },
		];
		assert.throws(() => migrate(database, broken), /boom/);
		assert.equal(database.pragma("user_version", { simple: true }), 1);
		const columns = (database.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name);
		assert.deepEqual(columns, ["a"], "the half-applied ALTER is undone");
		assert.equal((database.prepare("SELECT a FROM t").get() as { a: string }).a, "kept");
		database.close();
	});

	it("rejects a migration list with gaps or repeats", () => {
		const database = memoryDatabase();
		assert.throws(() => migrate(database, [{ version: 2, up: () => {} }]), /without gaps/);
		assert.throws(() => migrate(database, [{ version: 1, up: () => {} }, { version: 1, up: () => {} }]), /without gaps/);
		database.close();
	});

	it("keeps the shipped list numbered from 1", () => {
		MIGRATIONS.forEach((migration, index) => assert.equal(migration.version, index + 1));
		assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
	});

	it("requires fresh structured descriptions without converting old Markdown or removing user tags", () => {
		const database = memoryDatabase();
		migrate(database, MIGRATIONS.slice(0, 1));
		database.prepare("INSERT INTO assets VALUES ('media', 'a.png', 'a.png', 'image', 1, 1, 1, NULL)").run();
		database.prepare("INSERT INTO tags VALUES ('tag', 'keep', 1)").run();
		database.prepare("INSERT INTO asset_tags VALUES ('media', 'tag', 1)").run();
		for (const table of ["image_vlm", "video_vlm", "audio_writeup"]) {
			database.prepare(`INSERT INTO ${table} VALUES ('media', 'ready', 'm', 1, NULL, '## Caption\nOld', 1)`).run();
		}
		database.prepare("INSERT INTO text_chunks VALUES ('parent', 'media', NULL, 'parent', 0, 3, 'old', 1, NULL, NULL)").run();
		database.prepare("INSERT INTO text_chunks VALUES ('old', 'media', 'parent', 'child', 0, 3, 'old', 1, NULL, NULL)").run();
		migrate(database);
		for (const table of ["image_vlm", "video_vlm", "audio_writeup"]) {
			const row = database.prepare(`SELECT status, description_json, error FROM ${table}`).get() as { status: string; description_json: unknown; error: string };
			assert.equal(row.status, "failed");
			assert.equal(row.description_json, null);
			assert.match(row.error, /Describe this asset again/);
		}
		assert.equal((database.prepare("SELECT count(*) AS n FROM text_chunks").get() as { n: number }).n, 0);
		assert.equal((database.prepare("SELECT count(*) AS n FROM asset_tags").get() as { n: number }).n, 1);
		database.close();
	});
});
