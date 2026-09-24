import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceTools } from "../src/pi-tools.ts";

test("workspace tools read and write relative to cwd", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-workspace-tools-"));
	try {
		await writeFile(join(root, "note.txt"), "hello");
		const workspace = createWorkspaceTools(root);
		const read = workspace.tools.find((tool) => tool.name === "read");
		const write = workspace.tools.find((tool) => tool.name === "write");
		assert.ok(read && write);

		const shown = await read.execute({ path: "note.txt" });
		const text = typeof shown === "string"
			? shown
			: Array.isArray(shown.content)
				? shown.content.map((part) => part.type === "text" ? part.text : "").join("")
				: shown.content;
		assert.match(text, /hello/);

		await write.execute({ path: "out.txt", content: "from agent" });
		assert.equal(await readFile(join(root, "out.txt"), "utf8"), "from agent");

		const outside = join(root, "..", "loom-outside.txt");
		await write.execute({ path: outside, content: "escaped" });
		assert.equal(await readFile(outside, "utf8"), "escaped");
		await rm(outside, { force: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
