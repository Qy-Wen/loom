import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import { ToolCatalog, ToolExecutor, type LoomToolResult } from "@loom/agent/tools";
import { BACKGROUND_CONTEXT, toDurableTool, type ToolExecutionApi } from "@loom/agent/durable";
import { createAppToolCatalog } from "../src/main/tools/catalog.ts";

function catalog(core: LocalCore) {
	const unused = async (): Promise<never> => { throw new Error("Provider must not be called"); };
	return createAppToolCatalog(core, {
		assets: { embedAsset: unused, describeImage: unused, describeVideo: unused, describeAudio: unused },
		settings: { read: unused, apply: unused },
	});
}

test("application catalog shares external definitions including app settings and canvas operations", () => {
	const tools = catalog({} as LocalCore);
	assert.equal(tools.list("agent").length, 35);
	assert.equal(tools.list("external").length, 35);
	for (const name of ["get_settings", "update_settings"]) assert.equal(tools.get(name, "external").scope, "application");
	for (const name of ["list_canvases", "create_canvas", "read_canvas", "edit_canvas"]) assert.equal(tools.get(name, "external").scope, "library");
	for (const name of ["auto_memory", "run_retrieve_agent", "run_create_agent", "bash", "powershell", "comfy__generate"]) {
		assert.throws(() => tools.get(name, "external"), /not available/);
	}
	const search = tools.get("deep_search_assets", "external").tool.parameters as { required: string[] };
	assert.ok(search.required.includes("query"));
});

test("real library tools produce the same business data through Durable and external entry points", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-tool-catalog-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "note.txt"), "hello");
		const snapshot = await core.openLibrary(root);
		const asset = snapshot.assets[0]!;
		const executor = new ToolExecutor(catalog(core));
		const binding = core.bindLibraryTasks();
		const result = await executor.execute("add_tag", { assetId: asset.assetId, name: "Reviewed" }, {
			audience: "external", library: binding,
		}) as LoomToolResult;
		assert.deepEqual(result.data, { assetId: asset.assetId, tags: ["Reviewed"] });
		const tool = executor.agentTools(() => core.bindLibraryTasks()).find((item) => item.name === "inspect_asset")!;
		const internal = await toDurableTool(tool).execute({ assetId: asset.assetId }, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
		const external = await executor.execute("inspect_asset", { assetId: asset.assetId }, { audience: "external", library: binding }) as LoomToolResult;
		assert.deepEqual(internal.details, external.data);
		assert.deepEqual(internal.output, [{ type: "text", text: external.content }]);
		await assert.rejects(executor.execute("deep_search_assets", {}, { audience: "external", library: binding }), /Invalid arguments/);
	} finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test("a client binding expires even when the same library path is reopened", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-tool-binding-"));
	const core = new LocalCore();
	try {
		await core.openLibrary(root);
		const binding = core.bindLibraryTasks();
		const executor = new ToolExecutor(catalog(core));
		await core.openLibrary(root);
		await assert.rejects(executor.execute("list_tags", {}, { audience: "external", library: binding }), /bound library/);
		assert.deepEqual((await executor.execute("list_tags", {}, { audience: "external", library: core.bindLibraryTasks() }) as LoomToolResult).data, []);
	} finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test("a library switch cancels a running tool before it can touch the next library", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-tool-switch-"));
	const next = await mkdtemp(join(tmpdir(), "loom-tool-next-"));
	const core = new LocalCore();
	try {
		await core.openLibrary(root);
		const ready = Promise.withResolvers<void>();
		const executor = new ToolExecutor(new ToolCatalog(catalog(core).list("external").map((definition) => ({
			...definition,
			tool: {
				...definition.tool,
				execute: async (args, signal) => {
					ready.resolve();
					await new Promise<void>((resolve) => { signal!.addEventListener("abort", () => resolve(), { once: true }); });
					signal!.throwIfAborted();
					return definition.tool.execute(args, signal);
				},
			},
		}))));
		const running = executor.execute("create_property", { name: "Never create", type: "text" }, {
			audience: "external", library: core.bindLibraryTasks(),
		});
		const rejected = assert.rejects(running, { name: "AbortError" });
		await ready.promise;
		await core.openLibrary(next);
		await rejected;
		assert.deepEqual((await core.getPropertySnapshot()).properties, []);
	} finally { await core.close(); await rm(root, { recursive: true, force: true }); await rm(next, { recursive: true, force: true }); }
});
