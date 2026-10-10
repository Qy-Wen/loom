import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySettingsFile } from "../src/shared/model-settings.ts";
import { emptyMcpServerDraft } from "../src/shared/mcp-settings.ts";
import {
	chatSlotChanged,
	createSettingsTools,
	mergeMcpServers,
	modelChangeNotes,
	modelDraftForPatch,
	parseSettingsPatch,
	publicMcpServer,
	publicModelSlot,
	type PublicSettings,
	type SettingsPatch,
} from "../src/main/settings-tools.ts";

describe("settings tools", () => {
	it("hides keys and keeps an omitted chat window", () => {
		const file = emptySettingsFile();
		file.chat = { baseUrl: "http://localhost:11434/v1", apiKey: "secret", model: "llama", enabled: true, contextWindow: 32000 };
		file.embedding = { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "bge", enabled: true };
		assert.equal(publicModelSlot(file.chat).hasApiKey, true);
		assert.equal(JSON.stringify(publicModelSlot(file.chat)).includes("secret"), false);
		const draft = modelDraftForPatch(file, { embedding: { model: "bge-m3" } });
		assert.equal(draft.chat.contextWindow, 32000);
		assert.equal(draft.chat.apiKey, undefined);
		assert.equal(draft.embedding.model, "bge-m3");
		assert.equal(draft.embedding.enabled, true);
	});

	it("clears a chat window with 0 and refuses one on another slot", () => {
		const file = emptySettingsFile();
		file.chat.contextWindow = 32000;
		const cleared = modelDraftForPatch(file, { chat: { contextWindow: 0 } });
		assert.equal(cleared.chat.contextWindow, undefined);
		assert.throws(() => modelDraftForPatch(file, { embedding: { contextWindow: 8000 } }), /Chat slot/);
		assert.throws(() => parseSettingsPatch({}), /at least one change/);
	});

	it("keeps MCP env when an update omits it and hides the value", () => {
		const current = {
			...emptyMcpServerDraft(),
			id: "comfy",
			transport: "stdio" as const,
			command: "comfy",
			envText: "TOKEN=secret",
			enabled: true,
		};
		const next = mergeMcpServers([current], { upsert: [{ id: "comfy", enabled: false }] });
		assert.equal(next[0]?.envText, "TOKEN=secret");
		assert.equal(next[0]?.enabled, false);
		assert.equal(publicMcpServer(current).hasEnv, true);
		assert.equal(JSON.stringify(publicMcpServer(current)).includes("secret"), false);
		const removed = mergeMcpServers([current], { remove: ["comfy"] });
		assert.equal(removed.length, 0);
	});

	it("names the indexes that need a rebuild", () => {
		const before = emptySettingsFile();
		const after = emptySettingsFile();
		after.vlm = { ...after.vlm, model: "qwen-vl" };
		assert.deepEqual(modelChangeNotes(before, after), [
			"VLM model changed. Existing image and video write-ups for the previous model stay unused until those files are described again.",
		]);
		after.chat = { ...after.chat, model: "next" };
		assert.equal(chatSlotChanged(before, after), true);
	});

	it("reads through get_settings and writes a partial patch", async () => {
		const settings: PublicSettings = {
			models: {
				chat: { baseUrl: "", model: "", enabled: false, hasApiKey: false },
				embedding: { baseUrl: "", model: "", enabled: false, hasApiKey: false },
				rerank: { baseUrl: "", model: "", enabled: false, hasApiKey: false },
				vlm: { baseUrl: "", model: "", enabled: false, hasApiKey: false },
				audio: { baseUrl: "", model: "", enabled: false, hasApiKey: false },
			},
			sandbox: true,
			instructions: "",
			mcp: [],
		};
		let seen: SettingsPatch | undefined;
		const [getSettings, updateSettings] = createSettingsTools({
			read: async () => settings,
			apply: async (patch) => {
				seen = patch;
				return { notes: ["saved"], settings };
			},
		});
		assert.equal(await getSettings?.execute({}), JSON.stringify(settings, null, 2));
		const raw = await updateSettings?.execute({ sandbox: false, models: { chat: { model: "demo", apiKey: "sk-test" } } });
		assert.equal(seen?.sandbox, false);
		assert.equal(seen?.models?.chat?.model, "demo");
		assert.equal(seen?.models?.chat?.apiKey, "sk-test");
		assert.match(String(raw), /saved/);
		assert.equal(String(raw).includes("sk-test"), false);
	});
});
