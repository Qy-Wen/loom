import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCore } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "loom-library-"));
const core = new LocalCore();

try {
	await mkdir(join(root, ".loom"));
	await writeFile(join(root, ".loom", "ignored.txt"), "ignore me");
	await writeFile(join(root, "cover.jpg"), "image fixture");
	await mkdir(join(root, "notes"));
	await mkdir(join(root, "empty"));
	await writeFile(join(root, "notes", "brief.md"), "# Brief");

	const initial = await core.openLibrary(root);
	assert.deepEqual(initial.folders, ["empty", "notes"]);
	assert.deepEqual(
		initial.assets.map((asset) => asset.relativePath),
		["cover.jpg", "notes/brief.md"],
	);

	const added = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Watcher did not report the new file")), 3_000);
		const unsubscribe = core.subscribeLibrary((change) => {
			if (change.type === "upsert" && change.asset.relativePath === "clip.mp4") {
				clearTimeout(timeout);
				unsubscribe();
				resolve();
			}
		});
	});

	await writeFile(join(root, "clip.mp4"), "video fixture");
	await added;

	const final = await core.getLibrarySnapshot();
	assert.equal(final.assets.length, 3);
	console.log("library scan + watcher: ok");
} finally {
	await core.close();
	await rm(root, { recursive: true, force: true });
}
