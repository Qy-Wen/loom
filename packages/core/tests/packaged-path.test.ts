import assert from "node:assert/strict";
import { test } from "node:test";
import { unpackAsarPath } from "../src/packaged-path.ts";

test("unpackAsarPath rewrites an asar path and leaves other paths", () => {
	assert.equal(
		unpackAsarPath("/Applications/Loom.app/Contents/Resources/app.asar/node_modules/sqlite-vec-darwin-arm64/vec0.dylib"),
		"/Applications/Loom.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec-darwin-arm64/vec0.dylib",
	);
	assert.equal(
		unpackAsarPath("C:\\Program Files\\Loom\\resources\\app.asar\\vendor\\srt-win\\x64\\srt-win.exe"),
		"C:\\Program Files\\Loom\\resources\\app.asar.unpacked\\vendor\\srt-win\\x64\\srt-win.exe",
	);
	assert.equal(
		unpackAsarPath("/Applications/Loom.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node"),
		"/Applications/Loom.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
	);
	assert.equal(unpackAsarPath("/opt/homebrew/lib/libsqlite3.dylib"), "/opt/homebrew/lib/libsqlite3.dylib");
});
