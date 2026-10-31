import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messagesFor, uiPlatform } from "../src/shared/locale.ts";

describe("locale", () => {
	it("uses Chinese labels and the platform file manager", () => {
		const zh = messagesFor("zh-CN");
		const en = messagesFor("en");
		assert.equal(zh.app.openFolder, "打开文件夹");
		assert.equal(en.menu.reveal(uiPlatform("darwin")), "Show in Finder");
		assert.equal(zh.menu.reveal(uiPlatform("win32")), "在资源管理器中显示");
		assert.equal(en.menu.moveToTrash(uiPlatform("Windows NT")), "Move to Recycle Bin");
	});

	it("keeps graph captions concise and uses platform-specific graph controls in both languages", () => {
		for (const language of ["en", "zh-CN"] as const) {
			const graph = messagesFor(language).graph;
			assert.equal(graph.caption(3, 2), language === "en" ? "3 assets · 2 relations" : "3 个素材 · 2 条关系");
			const help = graph.help;
			for (const hint of [help.zoomHint, help.addHint]) {
				assert.match(hint("mac"), /⌘/);
				assert.doesNotMatch(hint("mac"), /Ctrl/);
				assert.match(hint("windows"), /Ctrl/);
				assert.doesNotMatch(hint("windows"), /⌘/);
				assert.equal(hint("other"), hint("windows"));
			}
			assert.match(help.addHint("mac"), /Shift/);
			assert.match(help.addHint("windows"), /Shift/);
			assert.match(help.removeHint("mac"), /⌫/);
			assert.match(help.removeHint("windows"), /Delete.*Backspace/);
			for (const platform of ["mac", "windows"] as const) assert.ok(help.panHint(platform));
		}
	});
});
