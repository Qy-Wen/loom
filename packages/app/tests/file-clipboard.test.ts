import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { readMacFilePaths } from "../src/main/desktop/mac-file-clipboard.ts";
import { decodeFileNameW, dropEffectIsMove } from "../src/shared/file-clipboard.ts";

describe("file clipboard formats", () => {
	it("reads one UTF-16 path and ignores trailing nulls", () => {
		const encoded = Buffer.from("C:\\shots\\a.txt\0\0", "utf16le");
		assert.equal(decodeFileNameW(encoded), "C:\\shots\\a.txt");
		assert.equal(decodeFileNameW(Buffer.alloc(0)), "");
	});

	it("treats drop effect 2 as a move", () => {
		assert.equal(dropEffectIsMove(Buffer.from([2, 0, 0, 0])), true);
		assert.equal(dropEffectIsMove(Buffer.from([5, 0, 0, 0])), false);
		assert.equal(dropEffectIsMove(Buffer.from([1, 0, 0, 0])), false);
		assert.equal(dropEffectIsMove(Buffer.alloc(0)), false);
	});

	it("reads only file URLs from a macOS pasteboard and keeps all paths intact", { skip: process.platform !== "darwin" }, async (t) => {
		const name = `loom-test-${randomUUID()}`;
		const paths = ["/tmp/中文 note.md", "/tmp/line\nbreak%.md"];
		const run = (body: string, ...args: string[]) => {
			const script = `
ObjC.import("AppKit");
function run([name, ...paths]) {
  const pasteboard = $.NSPasteboard.pasteboardWithName(name);
  ${body}
}
`;
			execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, "--", name, ...args], { timeout: 10_000 });
		};
		t.after(() => run("pasteboard.releaseGlobally;"));
		assert.deepEqual(await readMacFilePaths(name), []);

		run(`
const objects = $.NSMutableArray.alloc.init;
objects.addObject($.NSURL.URLWithString("https://example.com/"));
for (const path of paths) objects.addObject($.NSURL.fileURLWithPath(path));
pasteboard.clearContents;
if (!pasteboard.writeObjects(objects)) throw new Error("Could not write URLs to the test pasteboard");
`, ...paths);
		assert.deepEqual(await readMacFilePaths(name), paths);
	});
});
