import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGeneralSettings, resolveAppLanguage } from "../src/shared/general-settings.ts";

describe("general settings", () => {
	it("keeps the current startup behavior when the file is missing fields", () => {
		assert.deepEqual(parseGeneralSettings(null), { language: "system", reopenLastLibrary: true, webTools: true });
		assert.deepEqual(parseGeneralSettings({ language: "nope" }), { language: "system", reopenLastLibrary: true, webTools: true });
		assert.deepEqual(parseGeneralSettings({ language: "zh-CN", reopenLastLibrary: false }), {
			language: "zh-CN",
			reopenLastLibrary: false,
			webTools: true,
		});
		assert.equal(parseGeneralSettings({ webTools: false }).webTools, false);
	});

	it("follows a Chinese system language and leaves other systems in English", () => {
		assert.equal(resolveAppLanguage("system", "zh-CN"), "zh-CN");
		assert.equal(resolveAppLanguage("system", "zh-Hans-CN"), "zh-CN");
		assert.equal(resolveAppLanguage("system", "en-US"), "en");
		assert.equal(resolveAppLanguage("en", "zh-CN"), "en");
		assert.equal(resolveAppLanguage("zh-CN", "en-US"), "zh-CN");
	});
});
