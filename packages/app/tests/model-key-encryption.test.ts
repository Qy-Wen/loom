import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelSettingsStore } from "../src/main/models/model-settings-store.ts";
import type { ChatSecretCipher } from "../src/main/models/chat-credential-store.ts";
import { setStorageRecoveryLogger } from "../src/main/storage/file.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";

const KEY = Buffer.alloc(32, 9);
const SECRET = "sk-very-secret-value-123";

async function file(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "loom-keys-")), "model-settings.json");
}

const unavailable: ChatSecretCipher = {
	available: () => false,
	encrypt: () => { throw new Error("no keychain"); },
	decrypt: () => { throw new Error("no keychain"); },
};

describe("model slot API keys are encrypted at rest", () => {
	it("never writes the key to disk in plain text, and reads it back", async () => {
		const path = await file();
		const store = new ModelSettingsStore(path, testChatCipher(KEY));
		await store.update({ embedding: { requestUrl: "https://api.example.com/v1/embeddings", model: "m", apiKey: SECRET, enabled: true } });

		const text = await readFile(path, "utf8");
		assert.ok(!text.includes(SECRET), "the secret is not in the file");
		assert.ok(!/"apiKey"\s*:\s*"[^"]/.test(text), "no plain apiKey field with a value");
		assert.match(text, /apiKeyEncrypted/);
		assert.match(text, /api\.example\.com/, "the non-secret fields stay readable");

		const again = await new ModelSettingsStore(path, testChatCipher(KEY)).load();
		assert.equal(again.embedding.apiKey, SECRET);
		assert.equal(again.embedding.model, "m");
	});

	it("keeps each slot's key separate and drops the field when a key is cleared", async () => {
		const path = await file();
		const store = new ModelSettingsStore(path, testChatCipher(KEY));
		await store.update({ embedding: { apiKey: "key-embedding" }, vlm: { apiKey: "key-vlm" } });
		await store.update({ embedding: { clearApiKey: true } });
		const loaded = await store.load();
		assert.equal(loaded.embedding.apiKey, "");
		assert.equal(loaded.vlm.apiKey, "key-vlm");
		const raw = JSON.parse(await readFile(path, "utf8"));
		assert.equal(raw.embedding.apiKeyEncrypted, undefined);
		assert.ok(raw.vlm.apiKeyEncrypted);
	});

	it("reads a file written before keys were encrypted", async () => {
		const path = await file();
		await writeFile(path, JSON.stringify({ embedding: { requestUrl: "https://a/v1/embeddings", apiKey: SECRET, model: "m", enabled: true } }));
		const loaded = await new ModelSettingsStore(path, testChatCipher(KEY)).load();
		assert.equal(loaded.embedding.apiKey, SECRET);
	});

	it("protect() rewrites a plain-text file encrypted, keeps the key, and then does nothing", async () => {
		const path = await file();
		await writeFile(path, JSON.stringify({ embedding: { requestUrl: "https://a/v1/embeddings", apiKey: SECRET, model: "m", enabled: true } }));
		const store = new ModelSettingsStore(path, testChatCipher(KEY));
		assert.equal(await store.protect(), true);
		assert.ok(!(await readFile(path, "utf8")).includes(SECRET));
		assert.equal((await store.load()).embedding.apiKey, SECRET, "the key survives the rewrite");
		const before = await readFile(path, "utf8");
		assert.equal(await store.protect(), false, "already protected");
		assert.equal(await readFile(path, "utf8"), before, "and the file is not touched again");
	});

	it("protect() leaves a plain-text key alone when encryption is unavailable, rather than losing it", async () => {
		const path = await file();
		const original = JSON.stringify({ embedding: { requestUrl: "https://a/v1/embeddings", apiKey: SECRET, model: "m", enabled: true } });
		await writeFile(path, original);
		const store = new ModelSettingsStore(path, unavailable);
		assert.equal(await store.protect(), false);
		assert.equal(await readFile(path, "utf8"), original);
		assert.equal((await store.load()).embedding.apiKey, SECRET, "still usable");
	});

	it("refuses to save a key when encryption is unavailable instead of writing it in plain text", async () => {
		const path = await file();
		const store = new ModelSettingsStore(path, unavailable);
		await assert.rejects(() => store.update({ embedding: { apiKey: SECRET } }), /encryption is unavailable/);
		const files = await readdir(join(path, ".."));
		for (const name of files) assert.ok(!(await readFile(join(path, "..", name), "utf8")).includes(SECRET), `${name} has no secret`);
	});

	it("still saves other settings when encryption is unavailable and no key is set", async () => {
		const path = await file();
		const store = new ModelSettingsStore(path, unavailable);
		await store.update({ embedding: { requestUrl: "https://a/v1/embeddings", model: "m", enabled: true } });
		assert.equal((await store.load()).embedding.model, "m");
	});

	it("a key that cannot be decrypted is dropped and logged, and the other settings still load", async () => {
		const path = await file();
		await new ModelSettingsStore(path, testChatCipher(KEY)).update({
			embedding: { requestUrl: "https://a/v1/embeddings", model: "m", apiKey: SECRET, enabled: true },
		});
		const lines: string[] = [];
		setStorageRecoveryLogger((line) => lines.push(line));
		try {
			const loaded = await new ModelSettingsStore(path, testChatCipher(Buffer.alloc(32, 1))).load();
			assert.equal(loaded.embedding.apiKey, "");
			assert.equal(loaded.embedding.model, "m", "the rest of the slot is intact");
			assert.equal(loaded.embedding.requestUrl, "https://a/v1/embeddings");
		} finally {
			setStorageRecoveryLogger(undefined);
		}
		assert.ok(lines.some((line) => /could not be decrypted/.test(line)));
	});

	it("the view sent to the settings screen still carries the key, as before", async () => {
		const path = await file();
		const store = new ModelSettingsStore(path, testChatCipher(KEY));
		await store.update({ rerank: { apiKey: SECRET } });
		assert.equal((await store.view()).rerank.apiKey, SECRET);
	});
});
