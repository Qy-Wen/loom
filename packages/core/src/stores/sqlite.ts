import { mkdir } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Asset, AssetType } from "../model/asset.ts";
import type { AssetEnrichment, EnrichmentData, EnrichmentStatus } from "../model/enrichment.ts";
import {
	assertPropertyDefinition,
	assertPropertyValue,
	type AssetPropertyValue,
	type PropertyDefinition,
	type PropertyType,
} from "../model/property.ts";
import type { LibraryPaths } from "../library/paths.ts";
import type { MetadataStore } from "./types.ts";

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

interface PropertyRow {
	property_id: string;
	name: string;
	type: PropertyType;
	created_at: number;
}

interface AssetPropertyRow {
	asset_id: string;
	property_id: string;
	type: PropertyType;
	value_text: string | null;
	value_number: number | null;
	value_boolean: number | null;
	value_date: string | null;
}

const VOLUME_ID_KEY = "volume_id";

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
			this.ensureSchema(database);
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

	async replaceAssets(assets: Asset[]): Promise<void> {
		const database = this.requireDatabase();
		const replace = database.transaction((values: Asset[]) => {
			const nextAssetIds = new Set(values.map((asset) => asset.assetId));
			const existingAssetIds = database
				.prepare("SELECT asset_id FROM assets")
				.all() as Array<{ asset_id: string }>;

			// Stage existing paths in the ignored .loom namespace so two assets can
			// exchange paths without violating the unique relative_path constraint.
			// Rows are updated in place, preserving foreign-keyed user properties.
			database.prepare("UPDATE assets SET relative_path = '.loom/__reconcile__/' || asset_id").run();
			const upsert = database.prepare(`
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
			`);
			for (const value of values) {
				upsert.run({ ...value, fileSystemId: value.fileSystemId ?? null });
			}
			const remove = database.prepare("DELETE FROM assets WHERE asset_id = ?");
			for (const { asset_id: assetId } of existingAssetIds) {
				if (!nextAssetIds.has(assetId)) remove.run(assetId);
			}
		});
		replace(assets);
	}

	async removeAsset(assetId: string): Promise<void> {
		this.requireDatabase().prepare("DELETE FROM assets WHERE asset_id = ?").run(assetId);
	}

	async getLibraryVolumeId(): Promise<string | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT value FROM library_meta WHERE key = ?")
			.get(VOLUME_ID_KEY) as { value: string } | undefined;
		return row?.value;
	}

	async setLibraryVolumeId(volumeId: string): Promise<void> {
		this.requireDatabase()
			.prepare("INSERT INTO library_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(VOLUME_ID_KEY, volumeId);
	}

	async createProperty(property: PropertyDefinition): Promise<void> {
		assertPropertyDefinition(property);
		this.requireDatabase()
			.prepare("INSERT INTO properties (property_id, name, type, created_at) VALUES (?, ?, ?, ?)")
			.run(property.propertyId, property.name, property.type, property.createdAt);
	}

	async updateProperty(property: PropertyDefinition): Promise<void> {
		assertPropertyDefinition(property);
		const database = this.requireDatabase();
		const previous = await this.getProperty(property.propertyId);
		if (!previous) throw new Error("Property not found");
		if (previous.type !== property.type) {
			const count = database
				.prepare("SELECT COUNT(*) AS count FROM asset_properties WHERE property_id = ?")
				.get(property.propertyId) as { count: number };
			if (count.count > 0) throw new Error("Cannot change the type of a property that has values");
		}
		database
			.prepare("UPDATE properties SET name = ?, type = ? WHERE property_id = ?")
			.run(property.name, property.type, property.propertyId);
	}

	async getProperty(propertyId: string): Promise<PropertyDefinition | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM properties WHERE property_id = ?")
			.get(propertyId) as PropertyRow | undefined;
		return row ? toProperty(row) : undefined;
	}

	async listProperties(): Promise<PropertyDefinition[]> {
		const rows = this.requireDatabase()
			.prepare("SELECT * FROM properties ORDER BY name COLLATE NOCASE, name")
			.all() as PropertyRow[];
		return rows.map(toProperty);
	}

	async removeProperty(propertyId: string): Promise<void> {
		this.requireDatabase().prepare("DELETE FROM properties WHERE property_id = ?").run(propertyId);
	}

	async setAssetProperty(value: AssetPropertyValue): Promise<void> {
		const database = this.requireDatabase();
		const property = await this.getProperty(value.propertyId);
		if (!property) throw new Error("Property not found");
		if (!await this.getAsset(value.assetId)) throw new Error("Asset not found");
		assertPropertyValue(property.type, value.value);
		const columns = propertyValueColumns(property.type, value.value);
		database.prepare(`
			INSERT INTO asset_properties (
				asset_id, property_id, value_text, value_number, value_boolean, value_date
			) VALUES (
				@assetId, @propertyId, @valueText, @valueNumber, @valueBoolean, @valueDate
			)
			ON CONFLICT(asset_id, property_id) DO UPDATE SET
				value_text = excluded.value_text,
				value_number = excluded.value_number,
				value_boolean = excluded.value_boolean,
				value_date = excluded.value_date
		`).run({ ...value, ...columns });
	}

	async listAssetProperties(assetId: string): Promise<AssetPropertyValue[]> {
		const rows = this.requireDatabase().prepare(`
			SELECT ap.*, p.type
			FROM asset_properties ap
			JOIN properties p ON p.property_id = ap.property_id
			WHERE ap.asset_id = ?
			ORDER BY p.name COLLATE NOCASE, p.name
		`).all(assetId) as AssetPropertyRow[];
		return rows.map(toAssetProperty);
	}

	async listAllAssetProperties(): Promise<AssetPropertyValue[]> {
		const rows = this.requireDatabase().prepare(`
			SELECT ap.*, p.type
			FROM asset_properties ap
			JOIN properties p ON p.property_id = ap.property_id
			ORDER BY ap.asset_id, p.name COLLATE NOCASE, p.name
		`).all() as AssetPropertyRow[];
		return rows.map(toAssetProperty);
	}

	async removeAssetProperty(assetId: string, propertyId: string): Promise<void> {
		this.requireDatabase()
			.prepare("DELETE FROM asset_properties WHERE asset_id = ? AND property_id = ?")
			.run(assetId, propertyId);
	}

	async getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM asset_metadata WHERE asset_id = ?")
			.get(assetId) as AssetMetadataRow | undefined;
		return row ? toEnrichment(row) : undefined;
	}

	async upsertAssetEnrichment(record: AssetEnrichment): Promise<void> {
		if (!await this.getAsset(record.assetId)) throw new Error("Asset not found");
		this.requireDatabase().prepare(`
			INSERT INTO asset_metadata (
				asset_id, version, source_modified_at, status, error, data
			) VALUES (
				@assetId, @version, @sourceModifiedAt, @status, @error, @data
			)
			ON CONFLICT(asset_id) DO UPDATE SET
				version = excluded.version,
				source_modified_at = excluded.source_modified_at,
				status = excluded.status,
				error = excluded.error,
				data = excluded.data
		`).run({
			assetId: record.assetId,
			version: record.version,
			sourceModifiedAt: record.sourceModifiedAt,
			status: record.status,
			error: record.error ?? null,
			data: record.data ? JSON.stringify(record.data) : null,
		});
	}

	private ensureSchema(database: Database.Database): void {
		database.exec(`
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
		`);
	}

	private requireDatabase(): Database.Database {
		if (!this.database?.open) throw new Error("Metadata store is not open");
		return this.database;
	}
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

function toProperty(row: PropertyRow): PropertyDefinition {
	return {
		propertyId: row.property_id,
		name: row.name,
		type: row.type,
		createdAt: row.created_at,
	};
}

function propertyValueColumns(
	type: PropertyType,
	value: string | number | boolean,
): { valueText: string | null; valueNumber: number | null; valueBoolean: number | null; valueDate: string | null } {
	return {
		valueText: type === "text" ? value as string : null,
		valueNumber: type === "number" ? value as number : null,
		valueBoolean: type === "boolean" ? Number(value) : null,
		valueDate: type === "date" ? value as string : null,
	};
}

interface AssetMetadataRow {
	asset_id: string;
	version: number;
	source_modified_at: number;
	status: EnrichmentStatus;
	error: string | null;
	data: string | null;
}

function toEnrichment(row: AssetMetadataRow): AssetEnrichment {
	return {
		assetId: row.asset_id,
		version: row.version,
		sourceModifiedAt: row.source_modified_at,
		status: row.status,
		error: row.error ?? undefined,
		data: row.data ? JSON.parse(row.data) as EnrichmentData : undefined,
	};
}

function toAssetProperty(row: AssetPropertyRow): AssetPropertyValue {
	let value: string | number | boolean | null;
	if (row.type === "text") value = row.value_text;
	else if (row.type === "number") value = row.value_number;
	else if (row.type === "boolean") value = row.value_boolean === null ? null : row.value_boolean === 1;
	else value = row.value_date;
	if (value === null) throw new Error(`Property ${row.property_id} has no ${row.type} value`);
	return { assetId: row.asset_id, propertyId: row.property_id, value };
}
