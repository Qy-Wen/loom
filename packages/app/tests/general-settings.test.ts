import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGeneralSettings, parseGeneralSettingsPatch, resolveAppLanguage, resolveAppTheme } from "../src/shared/general-settings.ts";

describe("general settings", () => {
	it("keeps the current startup behavior when the file is missing fields", () => {
		assert.deepEqual(parseGeneralSettings(null), { language: "system", appearance: "system", reopenLastLibrary: true, webTools: true });
		assert.deepEqual(parseGeneralSettings({ language: "nope" }), { language: "system", appearance: "system", reopenLastLibrary: true, webTools: true });
		assert.deepEqual(parseGeneralSettings({ language: "zh-CN", reopenLastLibrary: false }), {
			language: "zh-CN",
			appearance: "system",
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

	it("stores the appearance choice and ignores unknown values", () => {
		assert.equal(parseGeneralSettings({ appearance: "dark" }).appearance, "dark");
		assert.equal(parseGeneralSettings({ appearance: "light" }).appearance, "light");
		assert.equal(parseGeneralSettings({ appearance: "sepia" }).appearance, "system");
		assert.deepEqual(parseGeneralSettingsPatch({ appearance: "dark" }), { appearance: "dark" });
		assert.deepEqual(parseGeneralSettingsPatch({ language: "en" }), { language: "en" });
	});

	it("paints the system theme only when the choice is system", () => {
		assert.equal(resolveAppTheme("system", true), "dark");
		assert.equal(resolveAppTheme("system", false), "light");
		assert.equal(resolveAppTheme("light", true), "light");
		assert.equal(resolveAppTheme("dark", false), "dark");
	});
});
