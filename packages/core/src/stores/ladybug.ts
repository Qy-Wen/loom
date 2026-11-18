import { createRequire } from "node:module";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { Connection, Database, QueryResult } from "@ladybugdb/wasm-core";
import type { LibraryPaths } from "../library/paths.ts";
import { referenceRelationId, REFERENCE_TYPE, type AssetRelation, type ReferenceSource } from "../model/relation.ts";
import { retryWindowsFileOperation } from "../fs-retry.ts";
import { REFERENCE, RELATED, type GraphStore } from "./types.ts";
const require = createRequire(import.meta.url);

interface WasmModule {
	Database: new (databasePath?: string) => Database;
	Connection: new (database: Database) => Connection;
	init: () => Promise<void>;
}

let wasm: WasmModule | undefined;

function loadWasm(): WasmModule {
	if (!wasm) wasm = require("@ladybugdb/wasm-core/nodejs") as WasmModule;
	return wasm;
}

function toCypherPath(absolutePath: string): string {
	return absolutePath.replaceAll("\\", "/").replaceAll("'", "\\'");
}

async function isExportedGraph(dir: string): Promise<boolean> {
	try {
		await access(join(dir, "schema.cypher"), constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Persistent GraphStore. Nodes are asset UUIDs; edges live in Ladybug WASM, not SQLite.
 * File-backed WASM databases fail on Windows (`getcwd`), so the engine stays in memory
 * and `.loom/graph-db/graph.db` is a Ladybug EXPORT/IMPORT directory.
 */
export class LadybugGraphStore implements GraphStore {
	private database: Database | null = null;
	private connection: Connection | null = null;
	private exportDir: string | null = null;

	async open(paths: LibraryPaths): Promise<void> {
		await this.close();
		await mkdir(dirname(paths.graphDb), { recursive: true });
		const lbug = loadWasm();
		await lbug.init();
		const database = new lbug.Database(":memory:");
		const connection = new lbug.Connection(database);
		this.database = database;
		this.connection = connection;
		this.exportDir = paths.graphDb;
		if (await isExportedGraph(paths.graphDb)) {
			await this.run(`IMPORT DATABASE '${toCypherPath(paths.graphDb)}'`);
		}
		await this.run("CREATE NODE TABLE IF NOT EXISTS Asset(asset_id STRING, PRIMARY KEY (asset_id))");
		await this.run(`CREATE REL TABLE IF NOT EXISTS ${RELATED}(FROM Asset TO Asset, relation_id STRING, type STRING)`);
		await this.run(`CREATE REL TABLE IF NOT EXISTS ${REFERENCE}(FROM Asset TO Asset, source STRING)`);
	}

	async close(): Promise<void> {
		const connection = this.connection;
		const database = this.database;
		this.connection = null;
		this.database = null;
		this.exportDir = null;
		if (connection) await connection.close();
		if (database) await database.close();
	}

	async ensureAsset(assetId: string): Promise<void> {
		await this.run("MERGE (a:Asset {asset_id: $id})", { id: assetId });
	}

	async removeAsset(assetId: string): Promise<void> {
		await this.run("MATCH (a:Asset {asset_id: $id}) DETACH DELETE a", { id: assetId });
		await this.persist();
	}

	async upsertRelation(relation: AssetRelation): Promise<void> {
		await this.run("MERGE (a:Asset {asset_id: $id})", { id: relation.fromAssetId });
		await this.run("MERGE (a:Asset {asset_id: $id})", { id: relation.toAssetId });
		const params = {
			from: relation.fromAssetId,
			to: relation.toAssetId,
			id: relation.relationId,
			type: relation.type,
		};
		await this.run(`
			MATCH (a:Asset {asset_id: $from})-[r:${RELATED} {type: $type}]->(b:Asset {asset_id: $to})
			DELETE r
		`, params);
		await this.run(`
			MATCH (a:Asset {asset_id: $from}), (b:Asset {asset_id: $to})
			MERGE (a)-[r:${RELATED} {relation_id: $id, type: $type}]->(b)
		`, params);
		await this.persist();
	}

	async listRelations(assetId: string): Promise<AssetRelation[]> {
		const params = { id: assetId };
		const manual = await this.run(`
			MATCH (a:Asset)-[r:${RELATED}]->(b:Asset)
			WHERE a.asset_id = $id OR b.asset_id = $id
			RETURN a.asset_id AS from_id, b.asset_id AS to_id, r.relation_id AS relation_id, r.type AS rel_type
		`, params);
		const references = await this.run(`
			MATCH (a:Asset)-[r:${REFERENCE}]->(b:Asset)
			WHERE a.asset_id = $id OR b.asset_id = $id
			RETURN a.asset_id AS from_id, b.asset_id AS to_id, r.source AS source
		`, params);
		return [...toRelations(manual), ...toReferences(references)].sort(compareRelations);
	}

	async listAllRelations(): Promise<AssetRelation[]> {
		const manual = await this.run(`
			MATCH (a:Asset)-[r:${RELATED}]->(b:Asset)
			RETURN a.asset_id AS from_id, b.asset_id AS to_id, r.relation_id AS relation_id, r.type AS rel_type
		`);
		const references = await this.run(`
			MATCH (a:Asset)-[r:${REFERENCE}]->(b:Asset)
			RETURN a.asset_id AS from_id, b.asset_id AS to_id, r.source AS source
		`);
		return [...toRelations(manual), ...toReferences(references)].sort(compareRelations);
	}

	async removeRelation(relationId: string): Promise<void> {
		await this.run(`MATCH ()-[r:${RELATED}]->() WHERE r.relation_id = $id DELETE r`, { id: relationId });
		await this.persist();
	}

	async replaceReferences(fromAssetId: string, source: ReferenceSource, targetAssetIds: string[]): Promise<void> {
		const targets = [...new Set(targetAssetIds)].filter((id) => id !== fromAssetId);
		const existing = await this.run(`
			MATCH (a:Asset {asset_id: $from})-[r:${REFERENCE}]->(b:Asset)
			RETURN b.asset_id AS to_id, r.source AS source
		`, { from: fromAssetId });
		const unchanged = existing.length === targets.length
			&& existing.every((row) => row.source === source && targets.includes(String(row.to_id)));
		if (unchanged) return;
		await this.run(`MATCH (a:Asset {asset_id: $from})-[r:${REFERENCE}]->() DELETE r`, { from: fromAssetId });
		if (targets.length > 0) await this.run("MERGE (a:Asset {asset_id: $id})", { id: fromAssetId });
		for (const to of targets) {
			await this.run("MERGE (a:Asset {asset_id: $id})", { id: to });
			await this.run(`
				MATCH (a:Asset {asset_id: $from}), (b:Asset {asset_id: $to})
				CREATE (a)-[:${REFERENCE} {source: $source}]->(b)
			`, { from: fromAssetId, to, source });
		}
		await this.persist();
	}

	private async persist(): Promise<void> {
		const dest = this.exportDir;
		if (!dest) throw new Error("Graph store is not open");
		const staging = `${dest}.tmp`;
		await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		await this.run(`EXPORT DATABASE '${toCypherPath(staging)}'`);
		await rm(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		await retryWindowsFileOperation(() => rename(staging, dest));
	}

	private async run(
		statement: string,
		params?: Record<string, string>,
	): Promise<Record<string, unknown>[]> {
		const connection = this.requireConnection();
		const result = params
			? await this.execute(connection, statement, params)
			: await connection.query(statement);
		return collect(result);
	}

	private async execute(
		connection: Connection,
		statement: string,
		params: Record<string, string>,
	): Promise<QueryResult> {
		const prepared = await connection.prepare(statement);
		try {
			if (!prepared.isSuccess()) {
				throw new Error((await prepared.getErrorMessage()) || "Failed to prepare graph query");
			}
			return await connection.execute(prepared, params);
		} finally {
			await prepared.close();
		}
	}

	private requireConnection(): Connection {
		if (!this.connection) throw new Error("Graph store is not open");
		return this.connection;
	}
}

function compareRelations(a: AssetRelation, b: AssetRelation): number {
	return a.type.localeCompare(b.type) || a.relationId.localeCompare(b.relationId);
}

function toReferences(rows: Record<string, unknown>[]): AssetRelation[] {
	return rows
		.map((row) => {
			const fromAssetId = String(row.from_id ?? "");
			const toAssetId = String(row.to_id ?? "");
			const source: ReferenceSource = row.source === "canvas" ? "canvas" : "markdown";
			return {
				relationId: referenceRelationId(fromAssetId, toAssetId),
				fromAssetId,
				toAssetId,
				type: REFERENCE_TYPE,
				source,
			};
		})
		.filter((relation) => relation.fromAssetId && relation.toAssetId);
}

function toRelations(rows: Record<string, unknown>[]): AssetRelation[] {
	return rows
		.map((row) => ({
			relationId: String(row.relation_id ?? ""),
			fromAssetId: String(row.from_id ?? ""),
			toAssetId: String(row.to_id ?? ""),
			type: String(row.rel_type ?? ""),
			source: "manual" as const,
		}))
		.filter((relation) => relation.relationId && relation.fromAssetId && relation.toAssetId && relation.type);
}

async function collect(result: QueryResult): Promise<Record<string, unknown>[]> {
	try {
		if (!result.isSuccess()) {
			throw new Error((await result.getErrorMessage()) || "Graph query failed");
		}
		return await result.getAllObjects();
	} finally {
		await result.close();
	}
}
