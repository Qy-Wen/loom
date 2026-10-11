import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CommandAllowStore } from "../src/main/command-allow-store.ts";

describe("CommandAllowStore", () => {
	it("keeps remembered commands in the library and forgets them", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-command-allows-"));
		const unbound = new CommandAllowStore();
		assert.deepEqual(await unbound.bind(null), { allows: [], libraryOpen: false, root: null });
		await assert.rejects(() => unbound.add({ tool: "bash", match: "ls" }), /Open a library first/);

		const store = new CommandAllowStore();
		assert.deepEqual(await store.bind(root), { allows: [], libraryOpen: true, root });
		assert.deepEqual(await store.add({ tool: "bash", match: "git status" }), {
			allows: [{ tool: "bash", match: "git status" }],
			libraryOpen: true,
			root,
		});
		assert.equal((await store.add({ tool: "bash", match: "git status" })).allows.length, 1);

		const again = new CommandAllowStore();
		assert.deepEqual(await again.bind(root), {
			allows: [{ tool: "bash", match: "git status" }],
			libraryOpen: true,
			root,
		});
		assert.match(await readFile(join(root, ".loom", "command-allows.json"), "utf8"), /git status/);

		const other = await mkdtemp(join(tmpdir(), "loom-command-allows-other-"));
		const elsewhere = new CommandAllowStore();
		assert.deepEqual(await elsewhere.bind(other), { allows: [], libraryOpen: true, root: other });

		assert.deepEqual(await again.remove({ tool: "bash", match: "git status" }), { allows: [], libraryOpen: true, root });
		assert.deepEqual((await again.bind(root)).allows, []);
	});

	it("ignores a broken file until the next write", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-command-allows-bad-"));
		await mkdir(join(root, ".loom"));
		await writeFile(join(root, ".loom", "command-allows.json"), "{", "utf8");
		const store = new CommandAllowStore();
		assert.deepEqual(await store.bind(root), { allows: [], libraryOpen: true, root });
		await store.add({ tool: "extract_frame" });
		const again = new CommandAllowStore();
		assert.deepEqual((await again.bind(root)).allows, [{ tool: "extract_frame" }]);
	});
});
