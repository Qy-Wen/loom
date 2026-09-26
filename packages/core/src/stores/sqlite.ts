import { mkdir } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Asset, AssetType } from "../model/asset.ts";
import type { AssetEnrichment, EnrichmentData, EnrichmentStatus } from "../model/enrichment.ts";
import type { ImageVlmJobStatus, ImageVlmRecord } from "../model/image-vlm.ts";
import type {
	ChildEmbeddingUpdate,
	StoredTextChunk,
	TextChunkRole,
	TextEmbedJob,
	TextEmbedJobStatus,
} from "../model/text-embed.ts";
import {
	assertPropertyDefinition,
	assertPropertyValue,
	type AssetPropertyValue,
	type PropertyDefinition,
	type PropertyType,
} from "../model/property.ts";
import type { LibraryPaths } from "../library/paths.ts";
import { compileFtsQuery, searchDocument } from "../retrieval/text.ts";
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
			this.rebuildFtsIfStale();
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
			const occupant = database
				.prepare("SELECT asset_id FROM assets WHERE relative_path = ? AND asset_id != ?")
				.get(value.relativePath, value.assetId) as { asset_id: string } | undefined;
			database
				.prepare("DELETE FROM assets WHERE relative_path = ? AND asset_id != ?")
				.run(value.relativePath, value.assetId);
			if (occupant) this.deleteFts(database, occupant.asset_id);
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
			this.refreshFts(database, value.assetId);
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
		this.rebuildFts();
	}

	async removeAsset(assetId: string): Promise<void> {
		const database = this.requireDatabase();
		this.deleteFts(database, assetId);
		database.prepare("DELETE FROM assets WHERE asset_id = ?").run(assetId);
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
		const database = this.requireDatabase();
		const rows = database
			.prepare("SELECT asset_id FROM asset_properties WHERE property_id = ?")
			.all(propertyId) as Array<{ asset_id: string }>;
		database.prepare("DELETE FROM properties WHERE property_id = ?").run(propertyId);
		for (const { asset_id: assetId } of rows) this.refreshFts(database, assetId);
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
		this.refreshFts(database, value.assetId);
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
		const database = this.requireDatabase();
		database.prepare("DELETE FROM asset_properties WHERE asset_id = ? AND property_id = ?").run(assetId, propertyId);
		this.refreshFts(database, assetId);
	}

	async getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM asset_metadata WHERE asset_id = ?")
			.get(assetId) as AssetMetadataRow | undefined;
		return row ? toEnrichment(row) : undefined;
	}

	async listAssetEnrichments(): Promise<AssetEnrichment[]> {
		const rows = this.requireDatabase()
			.prepare("SELECT * FROM asset_metadata")
			.all() as AssetMetadataRow[];
		return rows.map(toEnrichment);
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
		this.refreshFts(this.requireDatabase(), record.assetId);
	}

	async getTextEmbedJob(assetId: string): Promise<TextEmbedJob | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM text_embed_jobs WHERE asset_id = ?")
			.get(assetId) as TextEmbedJobRow | undefined;
		return row ? toTextEmbedJob(row) : undefined;
	}

	async upsertTextEmbedJob(job: TextEmbedJob): Promise<void> {
		if (!await this.getAsset(job.assetId)) throw new Error("Asset not found");
		this.requireDatabase().prepare(`
			INSERT INTO text_embed_jobs (
				asset_id, status, model_id, source_modified_at, error, child_count, parent_count, updated_at
			) VALUES (
				@assetId, @status, @modelId, @sourceModifiedAt, @error, @childCount, @parentCount, @updatedAt
			)
			ON CONFLICT(asset_id) DO UPDATE SET
				status = excluded.status,
				model_id = excluded.model_id,
				source_modified_at = excluded.source_modified_at,
				error = excluded.error,
				child_count = excluded.child_count,
				parent_count = excluded.parent_count,
				updated_at = excluded.updated_at
		`).run({
			assetId: job.assetId,
			status: job.status,
			modelId: job.modelId ?? null,
			sourceModifiedAt: job.sourceModifiedAt,
			error: job.error ?? null,
			childCount: job.childCount,
			parentCount: job.parentCount,
			updatedAt: job.updatedAt,
		});
	}

	async replaceTextChunks(assetId: string, chunks: StoredTextChunk[]): Promise<void> {
		if (!await this.getAsset(assetId)) throw new Error("Asset not found");
		const database = this.requireDatabase();
		const replace = database.transaction((values: StoredTextChunk[]) => {
			database.prepare("DELETE FROM text_chunks WHERE asset_id = ? AND role = 'child'").run(assetId);
			database.prepare("DELETE FROM text_chunks WHERE asset_id = ? AND role = 'parent'").run(assetId);
			const insert = database.prepare(`
				INSERT INTO text_chunks (
					chunk_id, asset_id, parent_id, role, start_offset, end_offset, text, token_count, embedding, model_id
				) VALUES (
					@chunkId, @assetId, @parentId, @role, @startOffset, @endOffset, @text, @tokenCount, @embedding, @modelId
				)
			`);
			for (const chunk of values.filter((value) => value.role === "parent")) insert.run(toChunkParams(chunk));
			for (const chunk of values.filter((value) => value.role === "child")) insert.run(toChunkParams(chunk));
		});
		replace(chunks);
	}

	async listTextChunks(assetId: string): Promise<StoredTextChunk[]> {
		const rows = this.requireDatabase()
			.prepare("SELECT * FROM text_chunks WHERE asset_id = ? ORDER BY start_offset, role DESC, chunk_id")
			.all(assetId) as TextChunkRow[];
		return rows.map(toStoredChunk);
	}

	async updateChildEmbeddings(assetId: string, updates: ChildEmbeddingUpdate[]): Promise<void> {
		const database = this.requireDatabase();
		const update = database.prepare(`
			UPDATE text_chunks
			SET embedding = ?, model_id = ?
			WHERE asset_id = ? AND chunk_id = ? AND role = 'child'
		`);
		const write = database.transaction((values: ChildEmbeddingUpdate[]) => {
			for (const value of values) {
				update.run(embeddingToBlob(value.embedding), value.modelId, assetId, value.chunkId);
			}
		});
		write(updates);
	}

	async getImageVlm(assetId: string): Promise<ImageVlmRecord | undefined> {
		const row = this.requireDatabase()
			.prepare("SELECT * FROM image_vlm WHERE asset_id = ?")
			.get(assetId) as ImageVlmRow | undefined;
		return row ? toImageVlm(row) : undefined;
	}

	async upsertImageVlm(record: ImageVlmRecord): Promise<void> {
		if (!await this.getAsset(record.assetId)) throw new Error("Asset not found");
		this.requireDatabase().prepare(`
			INSERT INTO image_vlm (
				asset_id, status, model_id, source_modified_at, error, markdown, updated_at
			) VALUES (
				@assetId, @status, @modelId, @sourceModifiedAt, @error, @markdown, @updatedAt
			)
			ON CONFLICT(asset_id) DO UPDATE SET
				status = excluded.status,
				model_id = excluded.model_id,
				source_modified_at = excluded.source_modified_at,
				error = excluded.error,
				markdown = excluded.markdown,
				updated_at = excluded.updated_at
		`).run({
			assetId: record.assetId,
			status: record.status,
			modelId: record.modelId ?? null,
			sourceModifiedAt: record.sourceModifiedAt,
			error: record.error ?? null,
			markdown: record.markdown ?? null,
			updatedAt: record.updatedAt,
		});
		this.refreshFts(this.requireDatabase(), record.assetId);
	}

	async searchAssetIds(query: string): Promise<string[]> {
		const match = compileFtsQuery(query);
		if (!match) return [];
		const rows = this.requireDatabase()
			.prepare("SELECT asset_id FROM assets_fts WHERE assets_fts MATCH ?")
			.all(match) as Array<{ asset_id: string }>;
		return rows.map((row) => row.asset_id);
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
			CREATE TABLE IF NOT EXISTS image_vlm (
				asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
				status TEXT NOT NULL CHECK(status IN ('describing', 'ready', 'failed')),
				model_id TEXT,
				source_modified_at REAL NOT NULL,
				error TEXT,
				markdown TEXT,
				updated_at REAL NOT NULL
			);
		`);
	}

	private rebuildFtsIfStale(): void {
		const database = this.requireDatabase();
		const assets = database.prepare("SELECT COUNT(*) AS count FROM assets").get() as { count: number };
		const indexed = database.prepare("SELECT COUNT(*) AS count FROM assets_fts").get() as { count: number };
		if (assets.count !== indexed.count) this.rebuildFts();
	}

	private rebuildFts(): void {
		const database = this.requireDatabase();
		database.exec("DELETE FROM assets_fts");
		const ids = database.prepare("SELECT asset_id FROM assets").all() as Array<{ asset_id: string }>;
		for (const { asset_id: assetId } of ids) this.refreshFts(database, assetId);
	}

	private refreshFts(database: Database.Database, assetId: string): void {
		const asset = database.prepare("SELECT * FROM assets WHERE asset_id = ?").get(assetId) as AssetRow | undefined;
		this.deleteFts(database, assetId);
		if (!asset) return;
		const values = (database.prepare(`
			SELECT ap.*, p.type
			FROM asset_properties ap
			JOIN properties p ON p.property_id = ap.property_id
			WHERE ap.asset_id = ?
		`).all(assetId) as AssetPropertyRow[]).map((row) => toAssetProperty(row).value);
		const enrichmentRow = database
			.prepare("SELECT * FROM asset_metadata WHERE asset_id = ?")
			.get(assetId) as AssetMetadataRow | undefined;
		const vlmRow = database
			.prepare("SELECT status, markdown FROM image_vlm WHERE asset_id = ?")
			.get(assetId) as { status: ImageVlmJobStatus; markdown: string | null } | undefined;
		database.prepare("INSERT INTO assets_fts (asset_id, body) VALUES (?, ?)").run(
			assetId,
			searchDocument(
				asset.filename,
				asset.relative_path,
				values,
				enrichmentRow ? toEnrichment(enrichmentRow) : undefined,
				vlmRow?.status === "ready" ? vlmRow.markdown ?? undefined : undefined,
			),
		);
	}

	private deleteFts(database: Database.Database, assetId: string): void {
		database.prepare("DELETE FROM assets_fts WHERE asset_id = ?").run(assetId);
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

interface TextEmbedJobRow {
	asset_id: string;
	status: TextEmbedJobStatus;
	model_id: string | null;
	source_modified_at: number;
	error: string | null;
	child_count: number;
	parent_count: number;
	updated_at: number;
}

interface TextChunkRow {
	chunk_id: string;
	asset_id: string;
	parent_id: string | null;
	role: TextChunkRole;
	start_offset: number;
	end_offset: number;
	text: string;
	token_count: number;
	embedding: Buffer | null;
	model_id: string | null;
}

function toTextEmbedJob(row: TextEmbedJobRow): TextEmbedJob {
	return {
		assetId: row.asset_id,
		status: row.status,
		modelId: row.model_id ?? undefined,
		sourceModifiedAt: row.source_modified_at,
		error: row.error ?? undefined,
		childCount: row.child_count,
		parentCount: row.parent_count,
		updatedAt: row.updated_at,
	};
}

function toStoredChunk(row: TextChunkRow): StoredTextChunk {
	return {
		chunkId: row.chunk_id,
		assetId: row.asset_id,
		parentId: row.parent_id,
		role: row.role,
		startOffset: row.start_offset,
		endOffset: row.end_offset,
		text: row.text,
		tokenCount: row.token_count,
		embedding: blobToEmbedding(row.embedding),
		modelId: row.model_id ?? undefined,
	};
}

function toChunkParams(chunk: StoredTextChunk): Record<string, string | number | Buffer | null> {
	return {
		chunkId: chunk.chunkId,
		assetId: chunk.assetId,
		parentId: chunk.parentId,
		role: chunk.role,
		startOffset: chunk.startOffset,
		endOffset: chunk.endOffset,
		text: chunk.text,
		tokenCount: chunk.tokenCount,
		embedding: chunk.role === "parent" ? null : embeddingToBlob(chunk.embedding),
		modelId: chunk.modelId ?? null,
	};
}

function embeddingToBlob(values?: number[]): Buffer | null {
	if (!values) return null;
	return Buffer.from(new Float32Array(values).buffer);
}

function blobToEmbedding(blob: Buffer | null): number[] | undefined {
	if (!blob) return undefined;
	return Array.from(new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4)));
}

interface ImageVlmRow {
	asset_id: string;
	status: ImageVlmJobStatus;
	model_id: string | null;
	source_modified_at: number;
	error: string | null;
	markdown: string | null;
	updated_at: number;
}

function toImageVlm(row: ImageVlmRow): ImageVlmRecord {
	return {
		assetId: row.asset_id,
		status: row.status,
		modelId: row.model_id ?? undefined,
		sourceModifiedAt: row.source_modified_at,
		error: row.error ?? undefined,
		markdown: row.markdown ?? undefined,
		updatedAt: row.updated_at,
	};
}
