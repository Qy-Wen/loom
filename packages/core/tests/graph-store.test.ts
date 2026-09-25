import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { LibraryPaths } from "../src/library/paths.ts";
import { LadybugGraphStore } from "../src/stores/ladybug.ts";
import { InMemoryGraphStore } from "../src/stores/memory.ts";
import { GENERATED_FROM, type GraphStore } from "../src/stores/types.ts";

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
		it("upserts a unique GENERATED_FROM edge and lists both ends", async () => {
			await withStore(kind, async (store) => {
				await store.upsertRelation({
					relationId: "r1",
					fromAssetId: "out",
					toAssetId: "src",
					type: GENERATED_FROM,
				});
				await store.upsertRelation({
					relationId: "r1-dup",
					fromAssetId: "out",
					toAssetId: "src",
					type: GENERATED_FROM,
				});

				assert.deepEqual((await store.listRelations("out")).map((item) => item.relationId), ["r1-dup"]);
				assert.deepEqual((await store.listRelations("src")).map((item) => item.toAssetId), ["src"]);
				assert.deepEqual((await store.listAllRelations()).map((item) => item.relationId), ["r1-dup"]);
			});
		});

		it("cascades when an asset node is removed", async () => {
			await withStore(kind, async (store) => {
				await store.upsertRelation({
					relationId: "r1",
					fromAssetId: "out",
					toAssetId: "src",
					type: GENERATED_FROM,
				});
				await store.removeAsset("src");
				assert.deepEqual(await store.listRelations("out"), []);
				assert.deepEqual(await store.listRelations("src"), []);
			});
		});
	});
}

describe("ladybug graph store persist", () => {
	it("reloads GENERATED_FROM after reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-ladybug-persist-"));
		const paths = new LibraryPaths(root);
		const first = new LadybugGraphStore();
		try {
			await first.open(paths);
			await first.upsertRelation({
				relationId: "r1",
				fromAssetId: "out",
				toAssetId: "src",
				type: GENERATED_FROM,
			});
			await first.close();

			const second = new LadybugGraphStore();
			await second.open(paths);
			try {
				assert.deepEqual((await second.listRelations("out")).map((item) => item.toAssetId), ["src"]);
			} finally {
				await second.close();
			}
		} finally {
			await first.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
