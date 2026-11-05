import type Database from "better-sqlite3";

/**
 * Schema of `metadata.db`, as an ordered list of migrations. `PRAGMA user_version` holds how many have run.
 *
 * Rules for changing the schema:
 * - Never edit a migration that has shipped. Append a new one.
 * - A migration runs once, so it may use ALTER TABLE, copy data, or rebuild a table.
 * - Tables that hold what a user made (favorites, tags, properties, relations, write-ups) must keep their rows.
 *   Derived tables (full-text, chunks) can be rebuilt instead.
 * - Version 1 is every table as first released; it is idempotent so a library created before versions existed
 *   (user_version 0 with these tables already present) can run it safely.
 */
export interface Migration {
	version: number;
	up(database: Database.Database): void;
}

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
	asset_id TEXT PRIMARY KEY,
	relative_path TEXT NOT NULL UNIQUE,
	filename TEXT NOT NULL,
	type TEXT NOT NULL,
	size INTEGER NOT NULL,
	created_at REAL NOT NULL,
	modified_at REAL NOT NULL,
	file_system_id TEXT
);
CREATE INDEX IF NOT EXISTS assets_type_idx ON assets(type);
CREATE INDEX IF NOT EXISTS assets_file_system_id_idx ON assets(file_system_id);
CREATE TABLE IF NOT EXISTS library_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
	asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
	created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
	tag_id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_tags (
	asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
	tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
	created_at REAL NOT NULL,
	PRIMARY KEY (asset_id, tag_id)
);
CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags(tag_id);
CREATE TABLE IF NOT EXISTS properties (
	property_id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	type TEXT NOT NULL CHECK(type IN ('text', 'number', 'boolean', 'date')),
	created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_properties (
	asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
	property_id TEXT NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
	value_text TEXT,
	value_number REAL,
	value_boolean INTEGER CHECK(value_boolean IN (0, 1)),
	value_date TEXT,
	PRIMARY KEY (asset_id, property_id),
	CHECK (
		(value_text IS NOT NULL) +
		(value_number IS NOT NULL) +
		(value_boolean IS NOT NULL) +
		(value_date IS NOT NULL) = 1
	)
);
CREATE INDEX IF NOT EXISTS asset_properties_property_idx
	ON asset_properties(property_id);
CREATE TABLE IF NOT EXISTS asset_metadata (
	asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	source_modified_at REAL NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('ready', 'failed', 'skipped')),
	error TEXT,
	data TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
	asset_id UNINDEXED,
	body,
	tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS text_embed_jobs (
	asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK(status IN ('embedding', 'ready', 'failed')),
	model_id TEXT,
	source_modified_at REAL NOT NULL,
	error TEXT,
	child_count INTEGER NOT NULL DEFAULT 0,
	parent_count INTEGER NOT NULL DEFAULT 0,
	updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS text_chunks (
	chunk_id TEXT PRIMARY KEY,
	asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
	parent_id TEXT REFERENCES text_chunks(chunk_id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK(role IN ('parent', 'child')),
	start_offset INTEGER NOT NULL,
	end_offset INTEGER NOT NULL,
	text TEXT NOT NULL,
	token_count INTEGER NOT NULL,
	embedding BLOB,
	model_id TEXT,
	CHECK (
		(role = 'parent' AND parent_id IS NULL AND embedding IS NULL)
		OR (role = 'child' AND parent_id IS NOT NULL)
	)
);
CREATE INDEX IF NOT EXISTS text_chunks_asset_idx ON text_chunks(asset_id);
-- One row per child chunk; its rowid is the chunk's rowid in text_chunks.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	body,
	tokenize = 'unicode61 remove_diacritics 2'
);
-- A cascading delete (asset removed, chunks replaced) fires this, so no full-text row is left behind.
CREATE TRIGGER IF NOT EXISTS text_chunks_fts_delete AFTER DELETE ON text_chunks
WHEN old.role = 'child'
BEGIN
	DELETE FROM chunks_fts WHERE rowid = old.rowid;
END;
CREATE TABLE IF NOT EXISTS image_vlm (
	asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK(status IN ('describing', 'ready', 'failed')),
	model_id TEXT,
	source_modified_at REAL NOT NULL,
	error TEXT,
	markdown TEXT,
	updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS video_vlm (
	asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK(status IN ('describing', 'ready', 'failed')),
	model_id TEXT,
	source_modified_at REAL NOT NULL,
	error TEXT,
	markdown TEXT,
	updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_writeup (
	asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK(status IN ('describing', 'ready', 'failed')),
	model_id TEXT,
	source_modified_at REAL NOT NULL,
	error TEXT,
	markdown TEXT,
	updated_at REAL NOT NULL
);
		
`;

export const MIGRATIONS: readonly Migration[] = [
	{ version: 1, up: (database) => database.exec(INITIAL_SCHEMA) },
	{
		version: 2,
		up(database) {
			// Old descriptions are not converted. Preserve their rows and user metadata,
			// invalidate the derived media index, and require a fresh model response.
			for (const table of ["image_vlm", "video_vlm", "audio_writeup"]) {
				const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
				if (columns.some((column) => column.name === "description_json")) continue;
				database.exec(`
					ALTER TABLE ${table} ADD COLUMN description_json TEXT;
					ALTER TABLE ${table} DROP COLUMN markdown;
					DELETE FROM text_chunks WHERE asset_id IN (SELECT asset_id FROM ${table});
					DELETE FROM text_embed_jobs WHERE asset_id IN (SELECT asset_id FROM ${table});
					UPDATE ${table} SET status = 'failed', error = 'Description format changed. Describe this asset again.';
				`);
			}
			// Opening the library rebuilds file-level FTS from the current fields.
			database.prepare("DELETE FROM library_meta WHERE key = 'fts_format'").run();
		},
	},
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Bring a database up to {@link SCHEMA_VERSION}. All pending migrations share one transaction, so a failure
 * leaves the file exactly as it was. A database from a newer Loom is refused, not read: this version would
 * write rows the newer one cannot understand.
 */
export function migrate(database: Database.Database, migrations: readonly Migration[] = MIGRATIONS): void {
	migrations.forEach((migration, index) => {
		if (migration.version !== index + 1) throw new Error("Migrations must be numbered 1, 2, 3, ... without gaps");
	});
	const current = database.pragma("user_version", { simple: true }) as number;
	const latest = migrations.length;
	if (current > latest) {
		throw new Error(`This library was made by a newer version of Loom (schema ${current}; this version understands up to ${latest}). Update Loom to open it.`);
	}
	if (current === latest) return;
	database.transaction(() => {
		for (const migration of migrations) {
			if (migration.version <= current) continue;
			migration.up(database);
		}
		// PRAGMA does not take bound parameters; the value is a number from the list above.
		database.pragma(`user_version = ${latest}`);
	})();
}
