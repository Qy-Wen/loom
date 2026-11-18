import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import { CanvasStore } from "../src/main/canvas/store.ts";
import { included } from "../src/main/cloud-backup/snapshot.ts";
import { createCanvasTools } from "../src/main/tools/canvas-tools.ts";
import { parseCanvas, type CanvasSnapshot } from "../src/shared/canvas.ts";

const geometry = { x: 0, y: -120, width: 180, height: 120 };

test("JSON Canvas preserves standard extensions and validates geometry, references and paths", () => {
	const board = {
		custom: { label: "top-level extension" },
		nodes: [{
			id: "source", type: "file", ...geometry, file: "资料/会议.md", subpath: "#摘要",
			loom: { assetId: "source-id", custom: true },
		}, { id: "note", type: "text", ...geometry, text: "Hello" }],
		edges: [{ id: "from-note", fromNode: "note", toNode: "source", fromSide: "bottom", toEnd: "none", custom: 42 }],
	};
	assert.deepEqual(parseCanvas(board), board);
	assert.deepEqual(parseCanvas({}), { nodes: [], edges: [] });
	assert.throws(() => parseCanvas({ ...board, nodes: [board.nodes[0], board.nodes[0]] }), /duplicate/);
	assert.throws(() => parseCanvas({ ...board, nodes: [{ ...board.nodes[0], width: 0 }] }), /geometry/);
	assert.throws(() => parseCanvas({ ...board, nodes: board.nodes.slice(0, 1) }), /edge/);
	for (const file of ["../outside.md", "/absolute", "C:\\escape.md", ".loom/identity.json"]) {
		assert.throws(() => parseCanvas({ nodes: [{ ...board.nodes[0], file }] }), /content/);
	}
	assert.equal(included("项目/分镜.canvas"), true);
	assert.equal(included("项目/.loom-canvas.12345678-1234-1234-1234-123456789012.tmp"), false);
});

test("Agent and editor share optimistic saves and preserve other files and canvas extensions", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-canvas-"));
	const core = new LocalCore();
	const store = new CanvasStore(core);
	const tools = createCanvasTools(core, store);
	const call = async (name: string, input: Record<string, unknown>) => {
		const tool = tools.find((entry) => entry.name === name)!;
		const result = await core.runLibraryTask(async (signal) => tool.execute(input, signal));
		assert.ok(typeof result !== "string");
		return result.data;
	};
	try {
		await mkdir(join(root, "项目"));
		await writeFile(join(root, "项目", "原始.md"), "One source");
		await core.openLibrary(root);
		const source = (await core.getLibrarySnapshot()).assets[0]!;
		const { assetId, relativePath } = await call("create_canvas", { folder: "项目", name: "分镜" }) as { assetId: string; relativePath: string };
		assert.equal(relativePath, "项目/分镜.canvas");
		assert.deepEqual(await call("list_canvases", {}), [{ assetId, relativePath }]);
		await assert.rejects(call("create_canvas", { folder: "../", name: "Outside" }), /Invalid canvas folder/);

		const initial = await call("read_canvas", { assetId }) as CanvasSnapshot;
		const { nodes, edges } = initial.document;
		const saved = (await store.save(assetId, { nodes, edges, extension: "retain" }, initial.revision))!;
		const next = await call("edit_canvas", {
			assetId, revision: saved.revision,
			nodes: [
				{ id: "source", type: "file", ...geometry, assetId: source.assetId },
				{ id: "note", type: "text", ...geometry, text: "# First scene" },
			],
			edges: [{ id: "link", fromNode: "note", toNode: "source", label: "Use for opening" }],
		}) as CanvasSnapshot;
		assert.equal(next.document.extension, "retain");
		assert.equal(next.document.nodes[0]!.file, "项目/原始.md");
		assert.deepEqual(next.document.nodes[0]!.loom, { assetId: source.assetId });
		assert.deepEqual((await readdir(join(root, "项目"))).sort(), ["分镜.canvas", "原始.md"].sort());
		assert.equal(await store.save(assetId, saved.document, saved.revision), null);
		await assert.rejects(call("edit_canvas", { assetId, revision: saved.revision, removeNodes: ["source"] }), /Canvas changed/);

		await core.renameAsset(source.assetId, "新文件名");
		const afterRename = await call("edit_canvas", {
			assetId, revision: next.revision, nodes: [{ id: "note", x: 420 }],
		}) as CanvasSnapshot;
		assert.equal(afterRename.document.nodes[0]!.file, "项目/新文件名.md");
		assert.equal(afterRename.document.nodes[1]!.text, "# First scene");

		const afterRemove = await call("edit_canvas", { assetId, revision: afterRename.revision, removeNodes: ["source"] }) as CanvasSnapshot;
		assert.deepEqual(afterRemove.document.edges, []);
		assert.equal(await readFile(join(root, "项目", "新文件名.md"), "utf8"), "One source");

		await writeFile(join(root, relativePath), "external edits");
		assert.equal(await store.save(assetId, afterRemove.document, afterRemove.revision), null);
		await assert.rejects(store.read(assetId), SyntaxError);
		assert.equal(await readFile(join(root, relativePath), "utf8"), "external edits");
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
