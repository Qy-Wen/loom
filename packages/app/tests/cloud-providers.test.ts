import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultCloudConfig, type CloudConfigDraft } from "../src/shared/cloud-backup.ts";
import { CloudConfigStore } from "../src/main/cloud-backup/config.ts";
import { CosObjectStore } from "../src/main/cloud-backup/cos-store.ts";
import { createObjectStore, parseCloudConfig, type CloudConnection } from "../src/main/cloud-backup/providers.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";

test("config requires an explicit supported provider; unknown providers never fall back to COS", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-cloud-provider-"));
	const path = join(directory, "cloud.json"), cipher = testChatCipher();
	const config = { ...defaultCloudConfig(), bucket: "example-1250000000" };
	try {
		const store = new CloudConfigStore(path, cipher);
		const credentials = { secretId: "new-id", secretKey: "new-key" };
		await store.save({ ...config, credentials });
		assert.ok(createObjectStore(await store.load()) instanceof CosObjectStore);
		const before = await readFile(path, "utf8");
		const saved = JSON.parse(before);
		assert.deepEqual(JSON.parse(cipher.decrypt(Buffer.from(saved.credentials, "base64"))), { provider: "cos", credentials });
		assert.throws(() => parseCloudConfig({ ...config, provider: "unknown" }), /Unsupported/);
		assert.throws(() => parseCloudConfig({ ...config, provider: undefined }), /Unsupported/);
		assert.throws(() => createObjectStore({ ...config, provider: "unknown", credentials } as unknown as CloudConnection), /Unsupported/);
		await assert.rejects(store.save({ ...config, provider: "unknown", credentials } as unknown as CloudConfigDraft), /Unsupported/);
		assert.equal(await readFile(path, "utf8"), before);
		await assert.rejects(store.save({ ...config, credentials: { secretId: 0, secretKey: 0 } } as unknown as CloudConfigDraft), /both/);
		// A credential envelope cannot be reused under a different provider.
		await writeFile(path, JSON.stringify({ ...saved, credentials: cipher.encrypt(JSON.stringify({ provider: "other", credentials })).toString("base64") }));
		await assert.rejects(store.load(), /do not match/);
		await writeFile(path, JSON.stringify({ ...saved, credentials: cipher.encrypt(JSON.stringify(credentials)).toString("base64") }));
		await assert.rejects(store.load(), /do not match/);
		await writeFile(path, JSON.stringify({ ...saved, provider: "unknown" }));
		await assert.rejects(store.view(), /Unsupported/);
		const { provider: _provider, ...missingProvider } = saved;
		await writeFile(path, JSON.stringify(missingProvider));
		await assert.rejects(store.view(), /Unsupported/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
