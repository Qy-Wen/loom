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
});
