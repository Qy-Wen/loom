import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	ModelSettingsStore,
	applySettingsDraft,
	parseSettingsFile,
	settingsView,
} from "../src/main/model-settings-store.ts";
import { emptySettingsFile, type ModelSettingsDraft } from "../src/shared/model-settings.ts";

function draft(overrides: Partial<ModelSettingsDraft["embedding"]> = {}): ModelSettingsDraft {
	const empty = { baseUrl: "", model: "", enabled: false };
	return {
		embedding: { baseUrl: "", model: "", enabled: false, ...overrides },
		rerank: empty,
		vlm: empty,
		audio: empty,
	};
}

describe("parseSettingsFile", () => {
	it("treats a filled slot without enabled as on", () => {
		const file = parseSettingsFile({ embedding: { baseUrl: "https://e", model: "embed" } });
		assert.equal(file.embedding.enabled, true);
		assert.equal(file.rerank.enabled, false);
	});
});

describe("applySettingsDraft", () => {
	it("keeps the stored key unless replaced or cleared", () => {
		const current = emptySettingsFile();
		current.embedding.apiKey = "kept";
		const kept = applySettingsDraft(current, draft({ baseUrl: "https://a", model: "m", enabled: true }));
		assert.equal(kept.embedding.apiKey, "kept");
		assert.equal(kept.embedding.enabled, true);
		const replaced = applySettingsDraft(current, draft({ baseUrl: "https://a", model: "m", apiKey: "new", enabled: true }));
		assert.equal(replaced.embedding.apiKey, "new");
		const cleared = applySettingsDraft(current, draft({ baseUrl: "https://a", model: "m", clearApiKey: true, enabled: true }));
		assert.equal(cleared.embedding.apiKey, "");
	});

	it("includes the key in the Settings view so it can be revealed", () => {
		const file = parseSettingsFile({ embedding: { baseUrl: "https://a", apiKey: "secret", model: "m" } });
		assert.deepEqual(settingsView(file).embedding, { baseUrl: "https://a", model: "m", apiKey: "secret", enabled: true });
	});
});

describe("ModelSettingsStore", () => {
	it("persists slots", async () => {
		const filePath = join(await mkdtemp(join(tmpdir(), "loom-settings-")), "model-settings.json");
		const store = new ModelSettingsStore(filePath);
		assert.deepEqual(await store.view(), emptySettingsFile());
		const saved = await store.update(draft({
			baseUrl: "https://api.example.com",
			model: "bge-m3",
			enabled: true,
		}));
		assert.equal(saved.embedding.apiKey, "");
		assert.match(await readFile(filePath, "utf8"), /bge-m3/);
		const later = await store.view();
		assert.equal(later.embedding.baseUrl, "https://api.example.com");
		assert.equal(later.embedding.model, "bge-m3");
	});
});
