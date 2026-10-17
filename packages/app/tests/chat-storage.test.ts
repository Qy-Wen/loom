import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { builtinProviders, getAllBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { AnyModel, Credential } from "@earendil-works/pi-ai";
import { ChatCredentialStore } from "../src/main/chat-credential-store.ts";
import { ChatCatalogStore } from "../src/main/chat-catalog-store.ts";
import { ChatConfigStore } from "../src/main/chat-config-store.ts";
import { atomicWrite } from "../src/main/chat-file.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";

async function workspace(t: { after(fn: () => Promise<void>): void }) {
	const dir = await mkdtemp(join(tmpdir(), "loom-chat-storage-"));
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	const key = randomBytes(32); const path = join(dir, "credentials.json");
	return { dir, key, path, credentials: new ChatCredentialStore(path, testChatCipher(key)) };
}

test("credentials encrypt API keys, OAuth extensions, env, and proxy headers with redacted enumeration", async (t) => {
	const { dir, path, key, credentials } = await workspace(t);
	await credentials.modify("openai", async () => ({ type: "api_key", key: "KEY_PRIVATE", env: { CUSTOM_KEY: "ENV_PRIVATE" } }));
	await credentials.modify("oauth", async () => ({ type: "oauth", access: "ACCESS_PRIVATE", refresh: "REFRESH_PRIVATE", expires: 42, accountId: "ACCOUNT_PRIVATE", extra: { scope: "scope" } }));
	await credentials.setSecret("openai", "proxy-auth", "HEADER_PRIVATE");
	const text = await readFile(path, "utf8");
	for (const secret of ["KEY_PRIVATE", "ENV_PRIVATE", "ACCESS_PRIVATE", "REFRESH_PRIVATE", "ACCOUNT_PRIVATE", "HEADER_PRIVATE"]) assert.ok(!text.includes(secret));
	assert.deepEqual(await credentials.list(), [{ providerId: "openai", type: "api_key" }, { providerId: "oauth", type: "oauth" }]);
	const reopened = new ChatCredentialStore(path, testChatCipher(key));
	assert.equal((await reopened.read("oauth"))!.type, "oauth");
	assert.equal(await reopened.getSecret("openai", "proxy-auth"), "HEADER_PRIVATE");
	await reopened.delete("openai");
	assert.equal(await reopened.read("openai"), undefined);
	assert.equal(await reopened.getSecret("openai", "proxy-auth"), "HEADER_PRIVATE");
	await reopened.setSecret("openai", "proxy-auth", undefined);
	assert.equal(await reopened.getSecret("openai", "proxy-auth"), undefined);
	assert.deepEqual(await readdir(dir), ["credentials.json"]);
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("undefined credential mutation does not write even if its callback mutates a detached read", async (t) => {
	const { path, credentials } = await workspace(t);
	await credentials.modify("openai", async () => ({ type: "api_key", key: "original" }));
	const before = await readFile(path, "utf8");
	const result = await credentials.modify("openai", async (current) => { if (current?.type === "api_key") current.key = "mutated"; return undefined; });
	assert.deepEqual(result, { type: "api_key", key: "original" });
	assert.equal(await readFile(path, "utf8"), before);
});

test("credential store never falls back to plaintext or overwrites an unreadable entry", async (t) => {
	const { dir, path, credentials } = await workspace(t);
	const unavailable = new ChatCredentialStore(path, { available: () => false, encrypt: () => { throw new Error("PRIVATE"); }, decrypt: () => { throw new Error("PRIVATE"); } });
	await assert.rejects(() => unavailable.modify("openai", async () => ({ type: "api_key", key: "PRIVATE" })), /plaintext fallback is disabled/);
	assert.deepEqual(await readdir(dir), []);
	await credentials.modify("openai", async () => ({ type: "api_key", key: "PRIVATE" }));
	const before = await readFile(path, "utf8");
	const wrongKey = new ChatCredentialStore(path, testChatCipher());
	await assert.rejects(() => wrongKey.modify("openai", async () => ({ type: "api_key", key: "replacement" })), /reconnect/);
	await assert.rejects(() => unavailable.read("openai"), /plaintext fallback/);
	assert.equal(await readFile(path, "utf8"), before);
});

test("credential corruption, invalid values, and thrown mutations leave storage intact", async (t) => {
	const { path, credentials } = await workspace(t);
	await credentials.modify("openai", async () => ({ type: "api_key", key: "original" }));
	const before = await readFile(path, "utf8");
	await assert.rejects(() => credentials.modify("openai", async () => { throw new Error("cancelled"); }), /cancelled/);
	await assert.rejects(() => credentials.modify("openai", async () => ({ type: "oauth", access: "PRIVATE", refresh: "r", expires: NaN })), /Invalid JSON/);
	await assert.rejects(() => credentials.modify("openai", async () => ({ type: "api_key", key: "PRIVATE", other: "bad" } as Credential)), /Invalid Chat credential/);
	assert.equal(await readFile(path, "utf8"), before);
	await writeFile(path, '{"version":9,"entries":{}}');
	await assert.rejects(() => credentials.read("openai"), /unsupported/);
	await writeFile(path, '{"PRIVATE":');
	await assert.rejects(() => credentials.list(), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
});

test("same-process store instances serialize full OAuth refresh callbacks", async (t) => {
	const { path, key, credentials } = await workspace(t);
	await credentials.modify("oauth-test", async () => ({ type: "oauth", access: "a0", refresh: "r0", expires: 0, generation: 0 }));
	let active = 0; let peak = 0;
	const clients = Array.from({ length: 8 }, () => new ChatCredentialStore(path, testChatCipher(key)));
	await Promise.all(clients.map((client) => client.modify("oauth-test", async (current) => {
		active++; peak = Math.max(peak, active);
		assert.equal(current?.type, "oauth");
		await new Promise((resolve) => setTimeout(resolve, 8));
		const generation = Number(current!.generation) + 1;
		active--;
		return { ...current, type: "oauth", access: `a${generation}`, refresh: `r${generation}`, expires: generation, generation };
	})));
	assert.equal(peak, 1);
	const saved = await credentials.read("oauth-test");
	assert.ok(saved?.type === "oauth"); assert.equal(saved.generation, 8);
});

test("separate processes coordinate OAuth token rotation without lost updates", async (t) => {
	const { path, key, credentials } = await workspace(t);
	await credentials.modify("oauth-test", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0, generation: 0 }));
	const worker = new URL("./fixtures/chat-storage-worker.ts", import.meta.url);
	const run = () => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(worker), path, key.toString("hex")], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "ignore", "pipe"] });
		let stderr = ""; child.stderr.on("data", (data) => { stderr += String(data); });
		child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker ${code}`)));
	});
	await Promise.all([run(), run(), run()]);
	const saved = await credentials.read("oauth-test");
	assert.ok(saved?.type === "oauth"); assert.equal(saved.generation, 12);
});

test("native Models refreshes an expiring OAuth token exactly once across encrypted-store clients", async (t) => {
	const { path, key, credentials } = await workspace(t);
	await credentials.modify("oauth-test", async () => ({ type: "oauth", access: "expired", refresh: "original", expires: 0, accountId: "ACCOUNT_PRIVATE" }));
	const faux = fauxProvider(); let refreshes = 0;
	const provider = createProvider({ id: "oauth-test", models: faux.models.map((model) => ({ ...model, provider: "oauth-test" })), api: faux.provider,
		auth: { oauth: { name: "Test OAuth", login: async () => { throw new Error("not used"); },
			refresh: async (current) => { refreshes++; await new Promise((resolve) => setTimeout(resolve, 25)); return { ...current, access: "new-access", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 }; },
			toAuth: async (current) => ({ apiKey: current.access }),
		} },
	});
	const clients = Array.from({ length: 5 }, () => {
		const models = createModels({ credentials: new ChatCredentialStore(path, testChatCipher(key)) }); models.setProvider(provider); return models;
	});
	const results = await Promise.all(clients.map((models) => models.getAuth("oauth-test")));
	assert.equal(refreshes, 1);
	for (const result of results) assert.equal(result!.auth.apiKey, "new-access");
	const saved = await credentials.read("oauth-test"); assert.ok(saved?.type === "oauth");
	assert.equal(saved.refresh, "rotated-refresh"); assert.equal(saved.accountId, "ACCOUNT_PRIVATE");
	const text = await readFile(path, "utf8"); assert.ok(!text.includes("rotated-refresh")); assert.ok(!text.includes("ACCOUNT_PRIVATE"));
});

test("failed native OAuth refresh preserves encrypted credentials", async (t) => {
	const { path, credentials } = await workspace(t);
	const original = { type: "oauth", access: "OLD_PRIVATE", refresh: "REFRESH_PRIVATE", expires: 0 } as const;
	await credentials.modify("oauth-test", async () => original);
	const before = await readFile(path, "utf8");
	const faux = fauxProvider();
	const provider = createProvider({ id: "oauth-test", models: faux.models, api: faux.provider, auth: { oauth: {
		name: "Test OAuth", login: async () => original,
		refresh: async () => { throw new Error("Refresh unavailable"); }, toAuth: async (current) => ({ apiKey: current.access }),
	} } });
	const models = createModels({ credentials }); models.setProvider(provider);
	await assert.rejects(() => models.getAuth("oauth-test"), /Refresh unavailable/);
	assert.deepEqual(await credentials.read("oauth-test"), original);
	assert.equal(await readFile(path, "utf8"), before);
});

test("logout waits for an active OAuth refresh and leaves no refreshed credential behind", async (t) => {
	const { credentials } = await workspace(t);
	const original = { type: "oauth", access: "OLD_PRIVATE", refresh: "REFRESH_PRIVATE", expires: 0 } as const;
	await credentials.modify("oauth-test", async () => original);
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const faux = fauxProvider();
	const provider = createProvider({ id: "oauth-test", models: faux.models, api: faux.provider, auth: { oauth: {
		name: "Test OAuth", login: async () => original,
		refresh: async (current) => {
			entered.resolve(); await release.promise;
			return { ...current, access: "NEW_PRIVATE", expires: Date.now() + 60_000 };
		}, toAuth: async (current) => ({ apiKey: current.access }),
	} } });
	const models = createModels({ credentials }); models.setProvider(provider);
	const refresh = models.getAuth("oauth-test");
	await entered.promise;
	try {
		const logout = models.logout("oauth-test");
		release.resolve();
		await Promise.all([refresh, logout]);
		assert.equal(await credentials.read("oauth-test"), undefined);
		assert.equal(await models.getAuth("oauth-test"), undefined);
	} finally { release.resolve(); await refresh; }
});

test("native Models API-key login/logout uses encrypted storage and retains environment source labels", async (t) => {
	const { credentials } = await workspace(t);
	const models = createModels({ credentials, authContext: { env: async (name) => name === "DEEPSEEK_API_KEY" ? "ENV_PRIVATE" : undefined, fileExists: async () => false } });
	models.setProvider(deepseekProvider());
	assert.equal((await models.checkAuth("deepseek"))!.source, "DEEPSEEK_API_KEY");
	await models.login("deepseek", "api_key", { prompt: async () => "KEY_PRIVATE", notify: () => {} });
	assert.equal((await models.checkAuth("deepseek"))!.source, "stored credential");
	assert.deepEqual(await credentials.list(), [{ providerId: "deepseek", type: "api_key" }]);
	assert.ok(!(await readFile(credentials.file.path, "utf8")).includes("KEY_PRIVATE"));
	await models.logout("deepseek");
	assert.equal(await credentials.read("deepseek"), undefined);
	assert.equal((await models.checkAuth("deepseek"))!.source, "DEEPSEEK_API_KEY");
});

test("aborted callers waiting for a lock do not write; rotated credentials still commit after cancellation", async (t) => {
	const { credentials } = await workspace(t);
	let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
	let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
	const controller = new AbortController();
	const first = credentials.modify("oauth", async () => { entered(); await gate; return { type: "oauth", access: "a", refresh: "r", expires: 1 }; }, { signal: controller.signal });
	await ready;
	const waiting = new AbortController(); let called = false;
	const second = credentials.modify("oauth", async () => { called = true; return undefined; }, { signal: waiting.signal });
	waiting.abort(); controller.abort(); finish();
	await assert.rejects(second, (error: unknown) => error instanceof Error && error.name === "AbortError");
	await first;
	assert.equal(called, false); assert.equal((await credentials.read("oauth"))!.type, "oauth");
});

test("native catalogs preserve operation/cost/thinking metadata and opaque ETags; request headers never persist", async (t) => {
	const { dir } = await workspace(t); const path = join(dir, "catalog.json"); const catalog = new ChatCatalogStore(path);
	const native: AnyModel[] = [...getAllBuiltinModels("openai"), { type: "image", id: "mock-image", name: "Mock image", api: "openai-image", provider: "openai", baseUrl: "https://api.openai.com/v1", input: ["text"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
	await catalog.write("openai", { models: native.map((model) => ({ ...model, headers: { Authorization: "HEADER_PRIVATE" } })), etag: 'W/"opaque"', checkedAt: 1, lastModified: 2 });
	assert.deepEqual((await new ChatCatalogStore(path).read("openai"))!, { models: native, etag: 'W/"opaque"', checkedAt: 1, lastModified: 2 });
	assert.ok(!(await readFile(path, "utf8")).includes("HEADER_PRIVATE"));
	const all = builtinProviders();
	for (const provider of all) await catalog.write(provider.id, { models: provider.getAllModels?.() ?? provider.getModels() });
	for (const provider of all) {
		const safeModels = (provider.getAllModels?.() ?? provider.getModels()).map((model) => { const safe = structuredClone(model); delete safe.headers; return safe; });
		assert.deepEqual((await catalog.read(provider.id))!.models, safeModels);
	}
	await catalog.delete("openai"); assert.equal(await catalog.read("openai"), undefined);
});

test("catalog writes serialize providers and reject malformed or secret metadata without replacing good data", async (t) => {
	const { dir } = await workspace(t); const path = join(dir, "catalog.json"); const catalog = new ChatCatalogStore(path);
	const native = openaiProvider().getModels().find((model) => (model.type ?? "chat") === "chat")!;
	await Promise.all(["a", "b", "c"].map((id) => new ChatCatalogStore(path).write(id, { models: [{ ...native, provider: id }] })));
	for (const id of ["a", "b", "c"]) assert.equal((await catalog.read(id))!.models[0]!.provider, id);
	const before = await readFile(path, "utf8");
	await assert.rejects(() => catalog.write("a", { models: [{ ...native, provider: "a", compat: { apiKey: "PRIVATE" } } as typeof native] }), /Secrets/);
	await assert.rejects(() => catalog.write("a", { models: [native] }), /metadata/);
	assert.equal(await readFile(path, "utf8"), before);
	await writeFile(path, '{"version":1,"entries":{"a":{"models":[],"etag":12}}}');
	await assert.rejects(() => catalog.read("a"), /Invalid Chat catalog/);
});

test("configuration refuses invalid replacement and never silently resets a malformed file", async (t) => {
	const { dir } = await workspace(t); const path = join(dir, "config.json"); const config = new ChatConfigStore(path);
	assert.deepEqual(await config.load(), { version: 1, providers: [] });
	await config.save({ version: 1, providers: [{ kind: "builtin", id: "openai", enabled: true }] });
	const before = await readFile(path, "utf8");
	await assert.rejects(() => config.save({ version: 9, providers: [] } as never), /Invalid/);
	assert.equal(await readFile(path, "utf8"), before);
	await writeFile(path, "bad json PRIVATE");
	await assert.rejects(() => config.load(), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
	await assert.rejects(() => config.save({ version: 1, providers: [] }), /Invalid JSON/);
});

test("atomic write leaves the prior destination intact when a commit guard fails", async (t) => {
	const { dir } = await workspace(t); const path = join(dir, "data.json"); await writeFile(path, "old");
	await assert.rejects(() => atomicWrite(path, "new", () => { throw new Error("lost lock"); }), /lost lock/);
	assert.equal(await readFile(path, "utf8"), "old"); assert.deepEqual(await readdir(dir), ["data.json"]);
});

test("native optional undefined fields normalize to JSON, without silently accepting functions or array holes", async (t) => {
	const { dir, credentials } = await workspace(t);
	await credentials.modify("openai", async () => ({ type: "api_key", key: "PRIVATE", env: undefined }));
	assert.deepEqual(await credentials.read("openai"), { type: "api_key", key: "PRIVATE" });
	const model = openaiProvider().getModels()[0]!; const catalog = new ChatCatalogStore(join(dir, "catalog.json"));
	await catalog.write("openai", { models: [{ ...model, inputLimits: undefined }], etag: undefined });
	assert.equal((await catalog.read("openai"))!.etag, undefined);
	await assert.rejects(() => catalog.write("openai", { models: [{ ...model, samplingParams: { callback: () => {} } }] }), /Invalid JSON/);
	await assert.rejects(() => credentials.modify("oauth", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1, extra: [undefined] })), /Invalid JSON/);
});
