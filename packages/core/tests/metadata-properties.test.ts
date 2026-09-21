import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import type { PropertyDefinition } from "../src/model/property.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";
import type { MetadataStore } from "../src/stores/types.ts";

function asset(assetId: string, relativePath: string): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").at(-1) ?? relativePath,
		type: "image",
		size: 10,
		createdAt: 1,
		modifiedAt: 2,
		fileSystemId: `1:${assetId}`,
	};
}

function property(propertyId: string, name: string, type: PropertyDefinition["type"]): PropertyDefinition {
	return { propertyId, name, type, createdAt: 100 };
}

async function withStore(
	kind: "memory" | "sqlite",
	run: (store: MetadataStore, paths: LibraryPaths) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), `loom-${kind}-properties-`));
	const store: MetadataStore = kind === "memory" ? new InMemoryMetadataStore() : new SqliteMetadataStore();
	const paths = new LibraryPaths(root);
	try {
		await store.open(paths);
		await run(store, paths);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
}

for (const kind of ["memory", "sqlite"] as const) {
	describe(`${kind} metadata properties`, () => {
		it("creates definitions and stores typed asset values", async () => {
			await withStore(kind, async (store) => {
				await store.upsertAsset(asset("a", "a.jpg"));
				const definitions = [
					property("status", "Status", "text"),
					property("rating", "Rating", "number"),
					property("featured", "Featured", "boolean"),
					property("shoot-date", "Shoot date", "date"),
				];
				for (const definition of definitions) await store.createProperty(definition);
				await store.setAssetProperty({ assetId: "a", propertyId: "status", value: "Published" });
				await store.setAssetProperty({ assetId: "a", propertyId: "rating", value: 4.5 });
				await store.setAssetProperty({ assetId: "a", propertyId: "featured", value: false });
				await store.setAssetProperty({ assetId: "a", propertyId: "shoot-date", value: "2026-09-21" });

				assert.deepEqual(
					Object.fromEntries((await store.listAssetProperties("a")).map((value) => [value.propertyId, value.value])),
					{ featured: false, rating: 4.5, "shoot-date": "2026-09-21", status: "Published" },
				);
				assert.deepEqual((await store.listProperties()).map((item) => item.name), [
					"Featured", "Rating", "Shoot date", "Status",
				]);
			});
		});

		it("validates updates and cascades removals", async () => {
			await withStore(kind, async (store) => {
				await store.upsertAsset(asset("a", "a.jpg"));
				await store.createProperty(property("rating", "Rating", "number"));
				await store.setAssetProperty({ assetId: "a", propertyId: "rating", value: 5 });

				await assert.rejects(
					store.setAssetProperty({ assetId: "a", propertyId: "rating", value: "5" }),
					/Invalid number/,
				);
				await assert.rejects(
					store.updateProperty(property("rating", "Rating text", "text")),
					/Cannot change the type/,
				);

				await store.updateProperty({ ...property("rating", "Score", "number"), createdAt: 999 });
				assert.deepEqual(await store.getProperty("rating"), {
					propertyId: "rating", name: "Score", type: "number", createdAt: 100,
				});
				await store.removeProperty("rating");
				assert.deepEqual(await store.listAssetProperties("a"), []);
			});
		});

		it("preserves values for retained assets during path swaps", async () => {
			await withStore(kind, async (store) => {
				const a = asset("a", "a.jpg");
				const b = asset("b", "b.jpg");
				await store.upsertAsset(a);
				await store.upsertAsset(b);
				await store.createProperty(property("status", "Status", "text"));
				await store.setAssetProperty({ assetId: "a", propertyId: "status", value: "Keep A" });
				await store.setAssetProperty({ assetId: "b", propertyId: "status", value: "Drop B" });

				await store.replaceAssets([
					{ ...a, relativePath: "b.jpg", filename: "b.jpg" },
					{ ...b, relativePath: "a.jpg", filename: "a.jpg" },
				]);
				assert.equal((await store.listAssetProperties("a"))[0]?.value, "Keep A");
				assert.equal((await store.listAssetProperties("b"))[0]?.value, "Drop B");

				await store.replaceAssets([{ ...a, relativePath: "b.jpg", filename: "b.jpg" }]);
				assert.equal((await store.listAssetProperties("a"))[0]?.value, "Keep A");
				assert.deepEqual(await store.listAssetProperties("b"), []);
				assert.ok(await store.getProperty("status"));
			});
		});
	});
}

it("SQLite persists custom properties across reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-sqlite-property-reopen-"));
	const paths = new LibraryPaths(root);
	const first = new SqliteMetadataStore();
	try {
		await first.open(paths);
		await first.upsertAsset(asset("a", "a.jpg"));
		await first.createProperty(property("status", "Status", "text"));
		await first.setAssetProperty({ assetId: "a", propertyId: "status", value: "Draft" });
		await first.close();

		const reopened = new SqliteMetadataStore();
		try {
			await reopened.open(paths);
			assert.equal((await reopened.listAssetProperties("a"))[0]?.value, "Draft");
		} finally {
			await reopened.close();
		}
	} finally {
		await first.close();
		await rm(root, { recursive: true, force: true });
	}
});
