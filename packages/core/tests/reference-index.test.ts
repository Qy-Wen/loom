import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LocalCore, type LibrarySnapshot } from "../src/index.ts";
import { ReferenceIndex } from "../src/library/reference-index.ts";
import type { LibrarySituation } from "../src/library/handlers.ts";
import type { Asset } from "../src/model/asset.ts";
import { InMemoryGraphStore } from "../src/stores/memory.ts";
import { retryWindowsFileOperation } from "../src/fs-retry.ts";
import { LadybugGraphStore } from "../src/stores/ladybug.ts";
import type { GraphStore } from "../src/stores/types.ts";

function asset(assetId: string, relativePath: string, size = 1): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").pop() ?? relativePath,
		type: "other",
		size,
		createdAt: 1,
		modifiedAt: 1,
	};
}

const added = (value: Asset): LibrarySituation => ({ type: "added", asset: value });

function createIndex(files: Map<string, string>) {
	const writes: string[] = [];
	const reads: string[] = [];
	const graph = {
		async replaceReferences(from: string, source: string, targets: string[]) {
			writes.push(`${from}:${source}:${targets.join(",")}`);
		},
	};
	const index = new ReferenceIndex(graph, async (path) => {
		reads.push(path);
		const text = files.get(path);
		if (text === undefined) throw new Error("ENOENT");
		return text;
	});
	return { index, writes, reads };
}

describe("ReferenceIndex", () => {
	it("reads each source once and writes only when targets change", async () => {
		const files = new Map([["a.md", "[[b]]"], ["b.md", ""]]);
		const { index, writes, reads } = createIndex(files);
		const a = asset("a", "a.md");
		const b = asset("b", "b.md");

		await index.sync([a, b], [added(a), added(b)]);
		assert.deepEqual(writes, ["a:markdown:b", "b:markdown:"]);
		assert.deepEqual(reads.sort(), ["a.md", "b.md"]);

		await index.sync([a, b], []);
		assert.equal(writes.length, 2);
		assert.equal(reads.length, 2);
	});

	it("re-reads only the updated source", async () => {
		const files = new Map([["a.md", "[[b]]"], ["b.md", "[[a]]"]]);
		const { index, writes, reads } = createIndex(files);
		const a = asset("a", "a.md");
		const b = asset("b", "b.md");
		await index.sync([a, b], [added(a), added(b)]);
		reads.length = 0;

		files.set("a.md", "");
		await index.sync([a, b], [{ type: "updated", asset: a, previous: a }]);
		assert.deepEqual(reads, ["a.md"]);
		assert.equal(writes.at(-1), "a:markdown:");
	});

	it("resolves again without reading when a target appears, moves or goes away", async () => {
		const files = new Map([["a.md", "[[dir/b]]"]]);
		const { index, writes, reads } = createIndex(files);
		const a = asset("a", "a.md");
		await index.sync([a], [added(a)]);
		assert.equal(writes.at(-1), "a:markdown:");

		const b = asset("b", "dir/b.md");
		await index.sync([a, b], [added(b)]);
		assert.equal(writes.at(-1), "a:markdown:b");

		const moved = asset("b", "elsewhere/b.md");
		await index.sync([a, moved], [{ type: "moved", asset: moved, previousPath: "dir/b.md" }]);
		assert.equal(writes.at(-1), "a:markdown:");

		await index.sync([a], [{ type: "removed", asset: moved }]);
		assert.equal(writes.at(-1), "a:markdown:");
		assert.equal(reads.filter((path) => path === "a.md").length, 1);
	});

	it("keeps the previous edges when a source becomes unreadable", async () => {
		const files = new Map([["s.canvas", JSON.stringify({ nodes: [{ id: "1", type: "file", file: "t.md" }], edges: [] })], ["t.md", ""]]);
		const { index, writes } = createIndex(files);
		const s = asset("s", "s.canvas");
		const t = asset("t", "t.md");
		await index.sync([s, t], [added(s), added(t)]);
		assert.ok(writes.includes("s:canvas:t"));
		const count = writes.length;

		files.set("s.canvas", "{");
		await index.sync([s, t], [{ type: "updated", asset: s, previous: s }]);
		assert.equal(writes.length, count);
	});

	it("skips oversized files and unrelated types", async () => {
		const { index, reads } = createIndex(new Map());
		const big = asset("big", "big.md", 9 * 1024 * 1024);
		const png = asset("png", "a.png");
		await index.sync([big, png], [added(big), added(png)]);
		assert.deepEqual(reads, []);
	});
});

async function renameRetry(from: string, to: string): Promise<void> {
	await retryWindowsFileOperation(() => rename(from, to));
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

type Edge = { from: string; to: string; source: string; type: string };

async function edges(core: LocalCore, snapshot: LibrarySnapshot): Promise<Edge[]> {
	const pathOf = new Map(snapshot.assets.map((item) => [item.assetId, item.relativePath]));
	return (await core.listGraphRelations())
		.map((item) => ({ from: pathOf.get(item.fromAssetId) ?? "?", to: pathOf.get(item.toAssetId) ?? "?", source: item.source, type: item.type }))
		.sort((a, b) => `${a.from}>${a.to}:${a.source}`.localeCompare(`${b.from}>${b.to}:${b.source}`));
}

it("renames a full filename, updating its type and references while keeping its ID", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-rename-extension-"));
	const core = new LocalCore({ graphStore: new InMemoryGraphStore() });
	try {
		const text = "[[target.png]]";
		await writeFile(join(root, "note.txt"), text);
		await writeFile(join(root, "target.png"), "image fixture");
		const initial = await core.openLibrary(root);
		const source = initial.assets.find((asset) => asset.filename === "note.txt")!;
		await core.setFavorite(source.assetId, true);

		await assert.rejects(core.renameAsset(source.assetId, "target.png", "filename"), /already exists/);
		const markdown = await core.renameAsset(source.assetId, "note.md", "filename");
		assert.equal(markdown.assetId, source.assetId);
		assert.deepEqual(await edges(core, await core.getLibrarySnapshot()), [
			{ from: "note.md", to: "target.png", source: "markdown", type: "reference" },
		]);

		const extensionless = await core.renameAsset(source.assetId, "note", "filename");
		assert.equal(extensionless.assetId, source.assetId);
		assert.equal(extensionless.filename, "note");
		assert.equal(extensionless.type, "other");
		assert.deepEqual(await core.getAsset(source.assetId), extensionless);
		assert.deepEqual(await core.listGraphRelations(), []);
		assert.deepEqual((await core.getLibrarySnapshot()).favoriteAssetIds, [source.assetId]);
		assert.equal(await readFile(join(root, "note"), "utf8"), text);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

for (const kind of ["memory", "ladybug"] as const) {
	describe(`LocalCore references (${kind} graph)`, () => {
		it("builds, updates and removes reference edges from file contents", async () => {
			const root = await mkdtemp(join(tmpdir(), `loom-refs-${kind}-`));
			const graphStore: GraphStore = kind === "memory" ? new InMemoryGraphStore() : new LadybugGraphStore();
			const core = new LocalCore({ graphStore });
			try {
				await mkdir(join(root, "产品"));
				await writeFile(join(root, "脚本.md"), "见 [[产品/说明]]，图 ![[架构图.png]]，`[[代码]]`，[[待调研]]\n");
				await writeFile(join(root, "产品", "说明.md"), "");
				await writeFile(join(root, "架构图.png"), "png");
				await writeFile(join(root, "演示.mp4"), "mp4");
				const snapshot = await core.openLibrary(root);
				const idOf = (path: string) => snapshot.assets.find((item) => item.relativePath === path)?.assetId ?? "";
				await writeFile(join(root, "分镜.canvas"), JSON.stringify({
					nodes: [
						{ id: "1", type: "file", file: "演示.mp4", x: 0, y: 0, width: 10, height: 10 },
						{ id: "2", type: "file", file: "演示.mp4", x: 0, y: 0, width: 10, height: 10, loom: { assetId: idOf("演示.mp4") } },
					],
					edges: [],
				}));

				await waitFor(async () => (await edges(core, await core.getLibrarySnapshot())).some((edge) => edge.from === "分镜.canvas"), "canvas edge");
				const current = await core.getLibrarySnapshot();
				assert.deepEqual(await edges(core, current), [
					{ from: "分镜.canvas", to: "演示.mp4", source: "canvas", type: "reference" },
					{ from: "脚本.md", to: "产品/说明.md", source: "markdown", type: "reference" },
					{ from: "脚本.md", to: "架构图.png", source: "markdown", type: "reference" },
				]);

				// A manual relationship on the same pair is kept next to the automatic one.
				const script = current.assets.find((item) => item.relativePath === "脚本.md");
				const notes = current.assets.find((item) => item.relativePath === "产品/说明.md");
				assert.ok(script && notes);
				const manual = await core.createRelation(script.assetId, notes.assetId, "refines");
				assert.equal((await edges(core, current)).filter((edge) => edge.from === "脚本.md" && edge.to === "产品/说明.md").length, 2);

				// Automatic edges cannot be removed through the relation API.
				const auto = (await core.listGraphRelations()).find((item) => item.source === "markdown");
				assert.ok(auto);
				await assert.rejects(core.removeRelation(auto.relationId), /source file/);

				// Details of the target show the backlink.
				const links = (await core.listAssetRelations(notes.assetId)).links;
				assert.deepEqual(links.map((link) => [link.direction, link.source, link.asset.relativePath]).sort(), [
					["in", "manual", "脚本.md"],
					["in", "markdown", "脚本.md"],
				]);

				// The missing target appears: the reference resolves without touching 脚本.md.
				await writeFile(join(root, "待调研.md"), "");
				await waitFor(async () => (await edges(core, await core.getLibrarySnapshot())).some((edge) => edge.to === "待调研.md"), "target appears");

				// Editing the source drops the edge.
				await writeFile(join(root, "脚本.md"), "只剩 [[产品/说明]]\n");
				await waitFor(async () => !(await edges(core, await core.getLibrarySnapshot())).some((edge) => edge.to === "待调研.md"), "edge dropped");

				// Moving a target keeps the edge because assets are tracked by ID.
				await renameRetry(join(root, "产品"), join(root, "产品线"));
				await waitFor(async () => (await core.getLibrarySnapshot()).assets.some((item) => item.relativePath === "产品线/说明.md"), "folder moved");
				await waitFor(async () => !(await edges(core, await core.getLibrarySnapshot())).some((edge) => edge.source === "markdown" && edge.to === "产品线/说明.md"), "reference now broken");

				// Removing the last canvas card removes the automatic edge; the manual edge stays.
				await writeFile(join(root, "分镜.canvas"), JSON.stringify({ nodes: [], edges: [] }));
				await waitFor(async () => !(await edges(core, await core.getLibrarySnapshot())).some((edge) => edge.from === "分镜.canvas"), "canvas edge removed");
				assert.ok((await core.listGraphRelations()).some((item) => item.relationId === manual.relationId));
			} finally {
				await core.close();
				await rm(root, { recursive: true, force: true });
			}
		});
	});
}

describe("LocalCore references after reopening", () => {
	it("drops edges whose source changed while the library was closed", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-refs-reopen-"));
		let core = new LocalCore();
		try {
			await writeFile(join(root, "a.md"), "[[b]] [[c]]");
			await writeFile(join(root, "b.md"), "");
			await writeFile(join(root, "c.md"), "");
			await core.openLibrary(root);
			assert.equal((await core.listGraphRelations()).length, 2);
			await core.close();

			await writeFile(join(root, "a.md"), "[[b]]");
			core = new LocalCore();
			await core.openLibrary(root);
			assert.equal((await core.listGraphRelations()).length, 1);
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
