import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultCloudConfig, type CloudConfigDraft } from "../src/shared/cloud-backup.ts";
import { CloudConfigStore } from "../src/main/cloud-backup/config.ts";
import { CloudBackupController } from "../src/main/cloud-backup/controller.ts";
import { CosObjectStore } from "../src/main/cloud-backup/cos-store.ts";
import { createObjectStore, parseCloudConfig, type CloudConnection } from "../src/main/cloud-backup/providers.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";

test("local-only is the default, needs no encryption, blocks cloud jobs and retains encrypted provider settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-cloud-disabled-"));
	const path = join(directory, "cloud.json"), baseCipher = testChatCipher();
	let unlocked = false, decryptions = 0, factories = 0, captures = 0;
	const store = new CloudConfigStore(path, { ...baseCipher, available: () => unlocked, decrypt(bytes) { decryptions++; if (!unlocked) throw new Error("Keychain unavailable"); return baseCipher.decrypt(bytes); } });
	const controller = new CloudBackupController(store, { capture: async () => { captures++; throw new Error("Must not capture"); }, pickRestoreParent: async () => undefined, openRestored: async () => {} }, () => {}, () => { factories++; throw new Error("Must not create cloud clients"); }, join(directory, "state.json"));
	const config = { provider: "cos" as const, bucket: "example-1250000000", region: "ap-shanghai", prefix: "loom/v1", credentials: { secretId: "retained-id", secretKey: "retained-key" } };
	try {
		assert.deepEqual(defaultCloudConfig(), { provider: "none" });
		assert.deepEqual((await store.view()).config, { provider: "none" });
		await controller.openLibrary(directory);
		assert.equal((await controller.view()).localLibrary, undefined);
		await controller.save({ provider: "none" });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { provider: "none" });
		assert.deepEqual(await controller.configuration(), { provider: "none" });
		unlocked = true; await controller.save(config);
		assert.ok((await controller.view()).localLibrary, "enabling cloud backup rebinds the already-open library");
		const otherLibrary = join(directory, "other-library"); await mkdir(otherLibrary);
		unlocked = false; await Promise.all([controller.save({ provider: "none" }), controller.openLibrary(otherLibrary)]);
		const view = await controller.view();
		assert.equal(view.hasCredentials, false); assert.equal(view.localLibrary, undefined); assert.deepEqual(view.libraries, []);
		assert.deepEqual(await controller.configuration(), { provider: "none" });
		assert.equal(decryptions, 0, "disabled configuration never decrypts the retained secret");
		assert.ok(!(await readFile(path, "utf8")).includes("retained-"));
		for (const operation of ["test", "backup", "preview", "pull", "list", "restore"] as const) await assert.rejects(controller.start(operation), /disabled/);
		assert.equal(factories, 0); assert.equal(captures, 0);
		const reopened = new CloudConfigStore(path, { ...baseCipher, available: () => false });
		assert.deepEqual(await reopened.configuration(), { provider: "none" });
		assert.equal((await reopened.view()).hasCredentials, false);
		unlocked = true;
		const editable = await controller.configuration("cos"); assert.ok(editable.provider === "cos");
		assert.deepEqual(editable.credentials, config.credentials);
		assert.equal((await controller.view()).config.provider, "none", "reading an editor draft does not enable cloud access");
		await controller.save({ ...editable, credentials: { secretId: "", secretKey: "" } });
		assert.deepEqual((await store.load()).credentials, config.credentials);
		assert.ok((await controller.view()).localLibrary);
		assert.equal((await controller.view()).hasCredentials, true);
	} finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
});

test("config requires an explicit supported provider; unknown providers never fall back to COS", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-cloud-provider-"));
	const path = join(directory, "cloud.json"), cipher = testChatCipher();
	const config = { provider: "cos" as const, bucket: "example-1250000000", region: "ap-shanghai", prefix: "loom/v1" };
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
