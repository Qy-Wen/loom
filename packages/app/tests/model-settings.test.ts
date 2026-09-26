import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	ModelSettingsStore,
	applySettingsDraft,
	copyBootstrapChatKey,
	parseSettingsFile,
	resolveChatEndpoint,
	settingsView,
} from "../src/main/model-settings-store.ts";
import { emptySettingsFile, type ModelSettingsDraft } from "../src/shared/model-settings.ts";

const env = { DEEPSEEK_API_KEY: "sk-from-env" };

function draft(overrides: Partial<ModelSettingsDraft["chat"]> = {}): ModelSettingsDraft {
	const empty = { baseUrl: "", model: "", enabled: false };
	return {
		chat: { baseUrl: "", model: "", enabled: false, ...overrides },
		embedding: empty,
		rerank: empty,
		vlm: empty,
		audio: empty,
	};
}

describe("resolveChatEndpoint", () => {
	it("uses a complete saved Chat slot and ignores env", () => {
		const file = emptySettingsFile();
		file.chat = { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local", model: "llama", enabled: true };
		assert.deepEqual(resolveChatEndpoint(file, env, true), {
			baseUrl: "http://127.0.0.1:11434/v1",
			apiKey: "local",
			model: "llama",
		});
	});

	it("bootstraps DeepSeek from env only when allowed", () => {
		assert.deepEqual(resolveChatEndpoint(emptySettingsFile(), env, true), {
			baseUrl: "https://api.deepseek.com",
			apiKey: "sk-from-env",
			model: "deepseek-v4-flash",
		});
		assert.equal(resolveChatEndpoint(emptySettingsFile(), env, false), undefined);
	});

	it("ignores a saved Chat slot that is turned off", () => {
		const file = emptySettingsFile();
		file.chat = { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local", model: "llama", enabled: false };
		assert.equal(resolveChatEndpoint(file, env, true), undefined);
	});
});

describe("applySettingsDraft", () => {
	it("keeps the stored key unless replaced or cleared", () => {
		const current = emptySettingsFile();
		current.chat.apiKey = "kept";
		const kept = applySettingsDraft(current, draft({ baseUrl: "https://a", model: "m", enabled: true }));
		assert.equal(kept.chat.apiKey, "kept");
		assert.equal(kept.chat.enabled, true);
		const replaced = applySettingsDraft(current, draft({ baseUrl: "https://a", model: "m", apiKey: "new", enabled: true }));
		assert.equal(replaced.chat.apiKey, "new");
		const cleared = applySettingsDraft(current, draft({ baseUrl: "https://a", model: "m", clearApiKey: true, enabled: true }));
		assert.equal(cleared.chat.apiKey, "");
	});

	it("includes the key in the Settings view so it can be revealed", () => {
		const file = parseSettingsFile({ chat: { baseUrl: "https://a", apiKey: "secret", model: "m" } });
		assert.deepEqual(settingsView(file).chat, { baseUrl: "https://a", model: "m", apiKey: "secret", enabled: true });
	});

	it("treats a filled slot without enabled as on", () => {
		const file = parseSettingsFile({ embedding: { baseUrl: "https://e", model: "embed" } });
		assert.equal(file.embedding.enabled, true);
		assert.equal(file.rerank.enabled, false);
	});
});

describe("copyBootstrapChatKey", () => {
	it("copies the env key when the first save keeps the DeepSeek prefill", () => {
		const next = emptySettingsFile();
		next.chat = { baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-v4-flash", enabled: true };
		copyBootstrapChatKey(next, draft({ baseUrl: next.chat.baseUrl, model: next.chat.model, enabled: true }), env);
		assert.equal(next.chat.apiKey, "sk-from-env");
	});

	it("does not copy the env key onto a different Chat endpoint", () => {
		const next = emptySettingsFile();
		next.chat = { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "llama", enabled: true };
		copyBootstrapChatKey(next, draft({ baseUrl: next.chat.baseUrl, model: next.chat.model, enabled: true }), env);
		assert.equal(next.chat.apiKey, "");
	});
});

describe("ModelSettingsStore", () => {
	it("persists slots and bootstraps Chat only before the first save", async () => {
		const filePath = join(await mkdtemp(join(tmpdir(), "loom-settings-")), "model-settings.json");
		const store = new ModelSettingsStore(filePath);
		const view = await store.view(env);
		assert.equal(view.chat.baseUrl, "https://api.deepseek.com");
		assert.equal(view.chat.apiKey, "sk-from-env");
		assert.equal(store.exists(), false);

		const saved = await store.update(draft({
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-flash",
			enabled: true,
		}), env);
		assert.equal(saved.chat.apiKey, "sk-from-env");
		assert.match(await readFile(filePath, "utf8"), /sk-from-env/);

		const later = await store.view({ DEEPSEEK_API_KEY: "other" });
		assert.equal(later.chat.baseUrl, "https://api.deepseek.com");
		assert.equal(later.chat.apiKey, "sk-from-env");
		assert.deepEqual(await store.chat({ DEEPSEEK_API_KEY: "other" }), {
			baseUrl: "https://api.deepseek.com",
			apiKey: "sk-from-env",
			model: "deepseek-v4-flash",
		});
	});
});
