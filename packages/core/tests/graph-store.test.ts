import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { LibraryPaths } from "../src/library/paths.ts";
import { LadybugGraphStore } from "../src/stores/ladybug.ts";
import { InMemoryGraphStore } from "../src/stores/memory.ts";
import { normalizeRelationType, type GraphStore } from "../src/stores/types.ts";

async function withStore(
	kind: "memory" | "ladybug",
	run: (store: GraphStore) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), `loom-${kind}-graph-`));
	const store: GraphStore = kind === "memory" ? new InMemoryGraphStore() : new LadybugGraphStore();
	try {
		await store.open(new LibraryPaths(root));
		await run(store);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
}

for (const kind of ["memory", "ladybug"] as const) {
	describe(`${kind} graph store`, () => {
		it("upserts a unique edge and lists both ends", async () => {
			await withStore(kind, async (store) => {
				await store.upsertRelation({
					relationId: "r1",
					fromAssetId: "out",
					toAssetId: "src",
					type: "derived",
					source: "manual",
				});
				await store.upsertRelation({
					relationId: "r1-dup",
					fromAssetId: "out",
					toAssetId: "src",
					type: "derived",
					source: "manual",
				});

				assert.deepEqual((await store.listRelations("out")).map((item) => item.relationId), ["r1-dup"]);
				assert.deepEqual((await store.listRelations("src")).map((item) => item.toAssetId), ["src"]);
				assert.deepEqual((await store.listAllRelations()).map((item) => item.relationId), ["r1-dup"]);
			});
		});

		it("upserts a unique RELATED edge by from, to, and type", async () => {
			await withStore(kind, async (store) => {
				await store.upsertRelation({
					relationId: "r1",
					fromAssetId: "a",
					toAssetId: "b",
					type: "similar",
					source: "manual",
				});
				await store.upsertRelation({
					relationId: "r1-dup",
					fromAssetId: "a",
					toAssetId: "b",
					type: "similar",
					source: "manual",
				});
				await store.upsertRelation({
					relationId: "r2",
					fromAssetId: "a",
					toAssetId: "b",
					type: "cut from",
					source: "manual",
				});

				assert.deepEqual(
					(await store.listAllRelations()).map((item) => item.relationId).sort(),
					["r1-dup", "r2"],
				);
			});
		});

		it("replaces the references that start at one file and keeps manual edges", async () => {
			await withStore(kind, async (store) => {
				await store.upsertRelation({ relationId: "m1", fromAssetId: "a", toAssetId: "b", type: "similar", source: "manual" });
				await store.replaceReferences("a", "markdown", ["b", "c", "c", "a"]);
				await store.replaceReferences("x", "canvas", ["b"]);

				const all = await store.listAllRelations();
				assert.deepEqual(
					all.map((item) => [item.fromAssetId, item.toAssetId, item.type, item.source]).sort(),
					[
						["a", "b", "reference", "markdown"],
						["a", "b", "similar", "manual"],
						["a", "c", "reference", "markdown"],
						["x", "b", "reference", "canvas"],
					],
				);
				assert.deepEqual((await store.listRelations("b")).length, 3);

				await store.replaceReferences("a", "markdown", ["c"]);
				assert.deepEqual(
					(await store.listAllRelations()).map((item) => `${item.fromAssetId}>${item.toAssetId}:${item.source}`).sort(),
					["a>b:manual", "a>c:markdown", "x>b:canvas"],
				);

				await store.replaceReferences("a", "markdown", []);
				assert.equal((await store.listAllRelations()).filter((item) => item.fromAssetId === "a" && item.source !== "manual").length, 0);
			});
		});

		it("does not remove a reference through removeRelation", async () => {
			await withStore(kind, async (store) => {
				await store.replaceReferences("a", "markdown", ["b"]);
				const [edge] = await store.listAllRelations();
				await store.removeRelation(edge.relationId);
				assert.equal((await store.listAllRelations()).length, 1);
			});
		});

		it("drops references when an asset node is removed", async () => {
			await withStore(kind, async (store) => {
				await store.replaceReferences("a", "markdown", ["b"]);
				await store.removeAsset("b");
				assert.deepEqual(await store.listAllRelations(), []);
			});
		});

		it("cascades when an asset node is removed", async () => {
			await withStore(kind, async (store) => {
				await store.upsertRelation({
					relationId: "r1",
					fromAssetId: "out",
					toAssetId: "src",
					type: "derived",
					source: "manual",
				});
				await store.removeAsset("src");
				assert.deepEqual(await store.listRelations("out"), []);
				assert.deepEqual(await store.listRelations("src"), []);
			});
		});
	});
}

describe("ladybug graph store persist", () => {
	it("reloads an edge after reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-ladybug-persist-"));
		const paths = new LibraryPaths(root);
		const first = new LadybugGraphStore();
		try {
			await first.open(paths);
			await first.upsertRelation({
				relationId: "r1",
				fromAssetId: "out",
				toAssetId: "src",
				type: "derived",
					source: "manual",
			});
			await first.replaceReferences("a", "markdown", ["c"]);
			await first.upsertRelation({
				relationId: "r2",
				fromAssetId: "a",
				toAssetId: "b",
				type: "similar",
					source: "manual",
			});
			await first.close();

			const second = new LadybugGraphStore();
			await second.open(paths);
			try {
				assert.deepEqual((await second.listRelations("out")).map((item) => item.toAssetId), ["src"]);
				assert.equal((await second.listAllRelations()).find((item) => item.type === "similar")?.toAssetId, "b");
				assert.deepEqual(
					(await second.listAllRelations()).filter((item) => item.source === "markdown").map((item) => item.toAssetId),
					["c"],
				);
			} finally {
				await second.close();
			}
		} finally {
			await first.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("normalizeRelationType", () => {
	it("trims and rejects reserved labels", () => {
		assert.equal(normalizeRelationType("  similar  "), "similar");
		assert.throws(() => normalizeRelationType(" "), /required/);
		assert.equal(normalizeRelationType("generated_from"), "generated_from");
		assert.throws(() => normalizeRelationType("RELATED"), /reserved/);
	});
});
