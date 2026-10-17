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
	const empty = { requestUrl: "", model: "", enabled: false };
	return {
		embedding: { requestUrl: "", model: "", enabled: false, ...overrides },
		rerank: empty,
		vlm: empty,
		audio: empty,
	};
}

describe("parseSettingsFile", () => {
	it("requires explicit enablement for a filled slot", () => {
		const file = parseSettingsFile({ embedding: { requestUrl: "https://e/v1/embeddings", model: "embed" } });
		assert.equal(file.embedding.enabled, false);
		assert.equal(file.rerank.enabled, false);
		assert.equal(parseSettingsFile({ embedding: { ...file.embedding, enabled: true } }).embedding.enabled, true);
	});
});

describe("applySettingsDraft", () => {
	it("keeps the stored key unless replaced or cleared", () => {
		const current = emptySettingsFile();
		current.embedding.apiKey = "kept";
		const kept = applySettingsDraft(current, draft({ requestUrl: "https://a", model: "m", enabled: true }));
		assert.equal(kept.embedding.apiKey, "kept");
		assert.equal(kept.embedding.enabled, true);
		const replaced = applySettingsDraft(current, draft({ requestUrl: "https://a", model: "m", apiKey: "new", enabled: true }));
		assert.equal(replaced.embedding.apiKey, "new");
		const cleared = applySettingsDraft(current, draft({ requestUrl: "https://a", model: "m", clearApiKey: true, enabled: true }));
		assert.equal(cleared.embedding.apiKey, "");
	});

	it("keeps exact request URLs and rejects invalid nonempty URLs", () => {
		const url = "https://proxy.example.com/inference/?region=cn";
		assert.equal(applySettingsDraft(emptySettingsFile(), draft({ requestUrl: ` ${url} ` })).embedding.requestUrl, url);
		assert.throws(() => applySettingsDraft(emptySettingsFile(), draft({ requestUrl: "not-a-url" })), /Request URL/);
	});

	it("includes the key in the Settings view for masked editing", () => {
		const file = parseSettingsFile({ embedding: { requestUrl: "https://a", apiKey: "secret", model: "m", enabled: true } });
		assert.deepEqual(settingsView(file).embedding, { requestUrl: "https://a", model: "m", apiKey: "secret", enabled: true });
	});
});

describe("ModelSettingsStore", () => {
	it("persists slots", async () => {
		const filePath = join(await mkdtemp(join(tmpdir(), "loom-settings-")), "model-settings.json");
		const store = new ModelSettingsStore(filePath);
		assert.deepEqual(await store.view(), emptySettingsFile());
		const saved = await store.update(draft({
			requestUrl: "https://api.example.com",
			model: "bge-m3",
			enabled: true,
		}));
		assert.equal(saved.embedding.apiKey, "");
		assert.match(await readFile(filePath, "utf8"), /bge-m3/);
		const later = await store.view();
		assert.equal(later.embedding.requestUrl, "https://api.example.com");
		assert.equal(later.embedding.model, "bge-m3");
	});
});
