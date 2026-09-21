import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileSystemIdFromDevIno, statAssetFile, statVolumeId } from "../src/library/file-identity.ts";

describe("file identity", () => {
	it("treats a zero inode as unknown", () => {
		assert.equal(fileSystemIdFromDevIno(1n, 0n), null);
		assert.equal(fileSystemIdFromDevIno(1n, 42n), "1:42");
	});

	it("reads a stable file id for a real file", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-file-id-"));
		const path = join(root, "sample.bin");
		try {
			await writeFile(path, "hello");
			const first = await statAssetFile(path);
			const second = await statAssetFile(path);
			assert.equal(first.isFile, true);
			assert.ok(first.fileSystemId);
			assert.equal(first.fileSystemId, second.fileSystemId);
			assert.equal(first.size, 5);
			assert.equal(await statVolumeId(root), await statVolumeId(path));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
