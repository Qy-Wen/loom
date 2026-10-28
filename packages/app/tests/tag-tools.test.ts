import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import type { LoomTool, LoomToolResult } from "@loom/agent";
import { createAssetTools } from "../src/main/tools/asset-tools.ts";
import { createTagTools } from "../src/main/tools/tag-tools.ts";

async function withLibrary(run: (setup: {
	core: LocalCore;
	ids: Record<string, string>;
	tool: (name: string) => LoomTool;
}) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "loom-tag-tools-"));
	const core = new LocalCore();
	try {
		for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(root, name), `# ${name} budget`);
		const snapshot = await core.openLibrary(root);
		const ids = Object.fromEntries(snapshot.assets.map((asset) => [asset.relativePath, asset.assetId]));
		const unused = async () => { throw new Error("not used"); };
		const tools = [
			...createTagTools(core),
			...createAssetTools(core, { embedAsset: unused, describeImage: unused, describeVideo: unused, describeAudio: unused }),
		];
		await run({ core, ids, tool: (name) => {
			const found = tools.find((candidate) => candidate.name === name);
			assert.ok(found, `tool ${name}`);
			return found;
		} });
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
}

const details = async (tool: LoomTool, args: unknown) => (await tool.execute(args) as LoomToolResult).details as Record<string, unknown>;
const assetNames = (result: Record<string, unknown>) =>
	(result.assets as Array<{ relativePath: string }>).map((asset) => asset.relativePath).sort();

test("add_tag creates a tag by its text, reuses it ignoring case, and shows it on the file", async () => {
	await withLibrary(async ({ core, ids, tool }) => {
		assert.deepEqual(await details(tool("add_tag"), { assetId: ids["a.md"], name: "  Draft  " }), { assetId: ids["a.md"], tags: ["Draft"] });
		// Same tag in another case: one tag in the library, and the first spelling is kept.
		await tool("add_tag").execute({ assetId: ids["b.md"], name: "draft" });
		assert.deepEqual((await core.getLibrarySnapshot()).tags.map((tag) => tag.name), ["Draft"]);
		// Adding it again changes nothing.
		assert.deepEqual(await details(tool("add_tag"), { assetId: ids["a.md"], name: "DRAFT" }), { assetId: ids["a.md"], tags: ["Draft"] });
		assert.deepEqual((await core.inspectAsset(ids["b.md"]!)).tags, ["Draft"]);
	});
});

test("add_tag rejects an empty name, a long name, a missing file, and a non-string name", async () => {
	await withLibrary(async ({ ids, tool }) => {
		const add = tool("add_tag");
		await assert.rejects(Promise.resolve().then(() => add.execute({ assetId: ids["a.md"], name: "   " })), /name/);
		await assert.rejects(Promise.resolve().then(() => add.execute({ assetId: ids["a.md"], name: "x".repeat(65) })), /too long/);
		await assert.rejects(Promise.resolve().then(() => add.execute({ assetId: "no-such-id", name: "Draft" })), /not found/i);
		await assert.rejects(Promise.resolve().then(() => add.execute({ assetId: ids["a.md"], name: 3 })), /name/);
		await assert.rejects(Promise.resolve().then(() => add.execute(null)), /object/);
	});
});

test("list_tags counts files per tag, most used first", async () => {
	await withLibrary(async ({ ids, tool }) => {
		assert.deepEqual(await (await tool("list_tags").execute({}) as LoomToolResult).details, []);
		await tool("add_tag").execute({ assetId: ids["a.md"], name: "Rare" });
		for (const name of ["a.md", "b.md", "c.md"]) await tool("add_tag").execute({ assetId: ids[name], name: "Common" });
		await tool("add_tag").execute({ assetId: ids["b.md"], name: "Mid" });
		await tool("add_tag").execute({ assetId: ids["c.md"], name: "Mid" });
		assert.deepEqual((await tool("list_tags").execute({}) as LoomToolResult).details, [
			{ name: "Common", count: 3 },
			{ name: "Mid", count: 2 },
			{ name: "Rare", count: 1 },
		]);
	});
});

test("remove_tag takes a tag off by name, reports a miss, and drops a tag no file uses", async () => {
	await withLibrary(async ({ core, ids, tool }) => {
		await tool("add_tag").execute({ assetId: ids["a.md"], name: "Draft" });
		await tool("add_tag").execute({ assetId: ids["b.md"], name: "Draft" });
		assert.deepEqual(await details(tool("remove_tag"), { assetId: ids["a.md"], name: "dRaFt" }), { assetId: ids["a.md"], removed: true, tags: [] });
		assert.deepEqual((await core.inspectAsset(ids["b.md"]!)).tags, ["Draft"], "other files keep it");
		assert.deepEqual(await details(tool("remove_tag"), { assetId: ids["a.md"], name: "Draft" }), { assetId: ids["a.md"], removed: false, tags: [] });
		assert.deepEqual(await details(tool("remove_tag"), { assetId: ids["a.md"], name: "Never existed" }), { assetId: ids["a.md"], removed: false, tags: [] });
		await tool("remove_tag").execute({ assetId: ids["b.md"], name: "Draft" });
		assert.deepEqual((await core.getLibrarySnapshot()).tags, [], "an unused tag leaves the library");
		await assert.rejects(Promise.resolve().then(() => tool("remove_tag").execute({ assetId: "no-such-id", name: "Draft" })), /not found/i);
	});
});

test("set_favorite marks and unmarks, and inspect_asset reports it", async () => {
	await withLibrary(async ({ core, ids, tool }) => {
		const set = tool("set_favorite");
		assert.equal((await core.inspectAsset(ids["a.md"]!)).favorite, false);
		assert.deepEqual(await details(set, { assetId: ids["a.md"], favorite: true }), { assetId: ids["a.md"], favorite: true });
		await set.execute({ assetId: ids["a.md"], favorite: true });
		assert.equal((await core.inspectAsset(ids["a.md"]!)).favorite, true);
		assert.equal((await core.inspectAsset(ids["b.md"]!)).favorite, false, "only that file");
		await set.execute({ assetId: ids["a.md"], favorite: false });
		assert.equal((await core.inspectAsset(ids["a.md"]!)).favorite, false);
		await assert.rejects(Promise.resolve().then(() => set.execute({ assetId: ids["a.md"], favorite: "yes" })), /true or false/);
		await assert.rejects(Promise.resolve().then(() => set.execute({ assetId: "no-such-id", favorite: true })), /not found/i);
	});
});

test("search_assets filters by tags (all of them, ignoring case) and by favorite", async () => {
	await withLibrary(async ({ ids, tool }) => {
		const add = tool("add_tag");
		await add.execute({ assetId: ids["a.md"], name: "Draft" });
		await add.execute({ assetId: ids["a.md"], name: "Client" });
		await add.execute({ assetId: ids["b.md"], name: "Draft" });
		await tool("set_favorite").execute({ assetId: ids["a.md"], favorite: true });
		await tool("set_favorite").execute({ assetId: ids["c.md"], favorite: true });
		const search = tool("search_assets");

		assert.deepEqual(assetNames(await details(search, { tags: ["draft"] })), ["a.md", "b.md"]);
		assert.deepEqual(assetNames(await details(search, { tags: ["Draft", "CLIENT"] })), ["a.md"], "every tag is required");
		assert.deepEqual(assetNames(await details(search, { tags: ["No such tag"] })), [], "an unknown tag matches nothing");
		assert.deepEqual(assetNames(await details(search, { tags: ["Draft", "No such tag"] })), []);
		assert.deepEqual(assetNames(await details(search, { tags: [] })), ["a.md", "b.md", "c.md"], "an empty list filters nothing");

		assert.deepEqual(assetNames(await details(search, { favorite: true })), ["a.md", "c.md"]);
		assert.deepEqual(assetNames(await details(search, { favorite: false })), ["b.md"]);
		assert.deepEqual(assetNames(await details(search, { tags: ["Draft"], favorite: true })), ["a.md"]);
		// Together with text.
		assert.deepEqual(assetNames(await details(search, { query: "budget", tags: ["Draft"], favorite: false })), ["b.md"]);

		await assert.rejects(Promise.resolve().then(() => search.execute({ tags: "Draft" })), /tags/);
		await assert.rejects(Promise.resolve().then(() => search.execute({ tags: [1] })), /tags/);
		await assert.rejects(Promise.resolve().then(() => search.execute({ favorite: "yes" })), /favorite/);
	});
});

test("deep_search_assets takes the same filters and still requires a query", async () => {
	await withLibrary(async ({ ids, tool }) => {
		await tool("add_tag").execute({ assetId: ids["a.md"], name: "Draft" });
		const deep = tool("deep_search_assets");
		await assert.rejects(Promise.resolve().then(() => deep.execute({ tags: ["Draft"] })), /query/);
		// Nothing is indexed, so there are no hits, but the filters are accepted and the call succeeds.
		const result = await details(deep, { query: "budget", tags: ["Draft"], favorite: false });
		assert.deepEqual(result.assets, []);
		assert.equal(result.indexedCount, 0);
	});
});

test("a tag survives a rename of the file", async () => {
	await withLibrary(async ({ core, ids, tool }) => {
		await tool("add_tag").execute({ assetId: ids["a.md"], name: "Draft" });
		await core.renameAsset(ids["a.md"]!, "renamed.md");
		assert.deepEqual((await core.inspectAsset(ids["a.md"]!)).tags, ["Draft"]);
	});
});
