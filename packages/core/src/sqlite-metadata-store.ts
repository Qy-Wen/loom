import { mkdir } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Asset, AssetType } from "./asset.ts";
import type { LibraryPaths } from "./library-paths.ts";
import type { MetadataStore } from "./stores.ts";

interface AssetRow {
	asset_id: string;
	relative_path: string;
	filename: string;
	type: string;
	size: number;
	created_at: number;
	modified_at: number;
	/** OS-assigned file identity; see Asset.fileSystemId. */
	file_system_id: string | null;
}

const SCHEMA_VERSION = 2;

export class SqliteMetadataStore implements MetadataStore {
	private database: Database.Database | null = null;

	async open(paths: LibraryPaths): Promise<void> {
		await this.close();
		await mkdir(paths.loom, { recursive: true });

		const database = new Database(paths.metadataDb);
		try {
			database.pragma("journal_mode = WAL");
			database.pragma("foreign_keys = ON");
			database.pragma("busy_timeout = 5000");
			this.migrate(database);
			this.database = database;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		const database = this.database;
		this.database = null;
		if (database?.open) database.close();
	}

	async upsertAsset(asset: Asset): Promise<void> {
		const database = this.requireDatabase();
		const upsert = database.transaction((value: Asset) => {
			// relative_path is unique. Removing a stale owner first mirrors the
			// in-memory store and lets an explicit rename preserve the asset UUID.
			database
				.prepare("DELETE FROM assets WHERE relative_path = ? AND asset_id != ?")
				.run(value.relativePath, value.assetId);
			database.prepare(`
				INSERT INTO assets (
					asset_id, relative_path, filename, type, size, created_at, modified_at, file_system_id
				) VALUES (
					@assetId, @relativePath, @filename, @type, @size, @createdAt, @modifiedAt, @fileSystemId
				)
				ON CONFLICT(asset_id) DO UPDATE SET
					relative_path = excluded.relative_path,
					filename = excluded.filename,
					type = excluded.type,
					size = excluded.size,
					created_at = excluded.created_at,
					modified_at = excluded.modified_at,
					file_system_id = excluded.file_system_id
			`).run({ ...value, fileSystemId: value.fileSystemId ?? null });
		});
		upsert(asset);
	}

	async getAsset(assetId: string): Promise<Asset | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM assets WHERE asset_id = ?")
			.get(assetId) as AssetRow | undefined;
		return row ? toAsset(row) : undefined;
	}

	async getAssetByPath(relativePath: string): Promise<Asset | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM assets WHERE relative_path = ?")
			.get(relativePath) as AssetRow | undefined;
		return row ? toAsset(row) : undefined;
	}

	async getAssetByFileSystemId(fileSystemId: string): Promise<Asset | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM assets WHERE file_system_id = ? LIMIT 1")
			.get(fileSystemId) as AssetRow | undefined;
		return row ? toAsset(row) : undefined;
	}

	async listAssets(): Promise<Asset[]> {
		const rows = this.requireDatabase()
			.prepare("SELECT * FROM assets ORDER BY relative_path COLLATE NOCASE, relative_path")
			.all() as AssetRow[];
		return rows.map(toAsset);
	}

	async removeAsset(assetId: string): Promise<void> {
		this.requireDatabase().prepare("DELETE FROM assets WHERE asset_id = ?").run(assetId);
	}

	private migrate(database: Database.Database): void {
		const version = database.pragma("user_version", { simple: true }) as number;
		if (version > SCHEMA_VERSION) {
			throw new Error(`metadata.db schema ${version} is newer than supported ${SCHEMA_VERSION}`);
		}
		if (version < 1) {
			database.transaction(() => {
				database.exec(`
					CREATE TABLE assets (
						asset_id TEXT PRIMARY KEY,
						relative_path TEXT NOT NULL UNIQUE,
						filename TEXT NOT NULL,
						type TEXT NOT NULL,
						size INTEGER NOT NULL,
						created_at REAL NOT NULL,
						modified_at REAL NOT NULL,
						file_system_id TEXT
					);
					CREATE INDEX assets_type_idx ON assets(type);
					CREATE INDEX assets_file_system_id_idx ON assets(file_system_id);
				`);
				database.pragma("user_version = 2");
			})();
			return;
		}
		if (version < 2) {
			database.transaction(() => {
				database.exec("ALTER TABLE assets ADD COLUMN file_system_id TEXT");
				database.exec("CREATE INDEX IF NOT EXISTS assets_file_system_id_idx ON assets(file_system_id)");
				database.pragma("user_version = 2");
			})();
		}
		renameLegacyFileIdColumn(database);
	}

	private requireDatabase(): Database.Database {
		if (!this.database?.open) throw new Error("Metadata store is not open");
		return this.database;
	}
}

function renameLegacyFileIdColumn(database: Database.Database): void {
	const columns = database.prepare("PRAGMA table_info(assets)").all() as { name: string }[];
	const names = new Set(columns.map((column) => column.name));
	if (!names.has("file_id") || names.has("file_system_id")) return;
	database.exec("ALTER TABLE assets RENAME COLUMN file_id TO file_system_id");
	database.exec("DROP INDEX IF EXISTS assets_file_id_idx");
	database.exec("CREATE INDEX IF NOT EXISTS assets_file_system_id_idx ON assets(file_system_id)");
}

function toAsset(row: AssetRow): Asset {
	return {
		assetId: row.asset_id,
		relativePath: row.relative_path,
		filename: row.filename,
		type: row.type as AssetType,
		size: row.size,
		createdAt: row.created_at,
		modifiedAt: row.modified_at,
		// OS filesystem identity (dev+ino / Windows file index), not Loom's UUID.
		fileSystemId: row.file_system_id,
	};
}
