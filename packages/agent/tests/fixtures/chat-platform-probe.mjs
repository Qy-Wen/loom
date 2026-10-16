// P0 Electron entry: synthetic credentials only, no real login or inference.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { get } from "node:http";
import { app, safeStorage } from "electron";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createModels } from "@earendil-works/pi-ai/models";

const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = argument("--probe-root");
const mode = argument("--probe-mode");
app.setPath("userData", join(root, "user-data"));
app.setName("Loom Chat Platform Probe");
// Never allow this probe to call a hosted service, even if future factories add I/O.
globalThis.fetch = async () => { throw new Error("P0_NETWORK_DISABLED"); };

function callbackStatus(url) {
	assert.equal(url.hostname, "127.0.0.1");
	return new Promise((resolve, reject) => {
		get(url, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); }).once("error", reject);
	});
}

async function probeOpenAICallback(provider) {
	const models = createModels(); models.setProvider(provider);
	const deviceId = "00000000-0000-4000-8000-000000000001";
	const prompt = (request) => new Promise((_resolve, reject) => {
		assert.equal(request.type, "manual_code");
		if (request.signal.aborted) reject(request.signal.reason);
		else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
	});
	let callbacks = Promise.resolve();
	let exchanged = false;
	const disabledFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token");
		assert.equal(options.body.get("client_id"), "p0-issued-client");
		assert.equal(options.body.get("code"), "p0-fake-code");
		assert.ok(options.body.get("code_verifier"));
		exchanged = true;
		return Response.json({ access_token: "p0-fake-access", refresh_token: "p0-fake-refresh", id_token: "p0-fake-id", expires_in: 3600, scope: "chatgpt.tokens.use.direct" });
	};
	try {
		const credential = await models.login("openai", "oauth", { signal: AbortSignal.timeout(5000), prompt, notify: (event) => {
			if (event.type !== "auth_url") return;
			const auth = new URL(event.url);
			assert.equal(auth.searchParams.get("agent_name_hint"), "Loom");
			assert.equal(auth.searchParams.get("ext_agent_host_id"), `urn:uuid:${deviceId}`);
			const callback = new URL(auth.searchParams.get("redirect_uri"));
			callback.search = new URLSearchParams({ code: "p0-fake-code", client_id: "p0-issued-client", state: "wrong-state" }).toString();
			callbacks = (async () => {
				assert.equal(await callbackStatus(callback), 400, "reject incorrect state before accepting a valid callback");
				callback.searchParams.set("state", auth.searchParams.get("state"));
				assert.equal(await callbackStatus(callback), 200);
			})();
			void callbacks.catch(() => {});
		} }, { getDeviceId: () => deviceId, agentName: "Loom" });
		await callbacks;
		assert.equal(credential.clientId, "p0-issued-client");
		assert.ok(exchanged);
		assert.equal((await models.getAuth("openai")).source, "OAuth");
		await models.logout("openai");
		globalThis.fetch = disabledFetch;
		const cancel = new AbortController();
		await assert.rejects(models.login("openai", "oauth", { signal: cancel.signal, prompt, notify: (event) => {
			if (event.type === "auth_url") cancel.abort(new Error("P0_CANCEL_LOGIN"));
		} }, { getDeviceId: () => deviceId, agentName: "Loom" }), /P0_CANCEL_LOGIN/);
		// Allow the provider's cancellation cleanup to release the loopback listener.
		await new Promise((resolve) => setTimeout(resolve, 50));
		await assert.rejects(callbackStatus(new URL("http://127.0.0.1:1455/auth/callback")), (error) => error.code === "ECONNREFUSED");
		return "mock-callback-state-validation-and-cancel-passed";
	} finally {
		globalThis.fetch = disabledFetch;
	}
}

async function probe() {
	const providers = builtinProviders();
	if (mode === "encrypt" || mode === "decrypt") {
		assert.ok(safeStorage.isEncryptionAvailable(), "OS-backed encryption unavailable; no plaintext fallback allowed");
		const marker = "loom-p0-synthetic-credential-not-a-real-key";
		const path = join(root, "credential.encrypted");
		if (mode === "encrypt") {
			const encrypted = safeStorage.encryptString(marker);
			assert.ok(!encrypted.includes(Buffer.from(marker)));
			await writeFile(path, encrypted, { mode: 0o600 });
		}
		assert.equal(safeStorage.decryptString(await readFile(path)), marker);
		return { encryption: mode, platform: process.platform, electron: process.versions.electron };
	}
	const loaded = [];
	for (const provider of providers.filter((provider) => provider.auth.oauth)) {
		try {
			const auth = await provider.auth.oauth.toAuth({ type: "oauth", access: "p0-fake-access", refresh: "p0-fake-refresh", expires: Date.now() + 3_600_000 });
			assert.ok(auth.apiKey || auth.headers?.Authorization);
			loaded.push(provider.id);
		} catch (error) {
			if (mode !== "bundled") throw error;
			// Expected baseline failure: opaque relative OAuth imports cannot survive flattening.
			assert.ok(error instanceof Error && error.code === "ERR_MODULE_NOT_FOUND", String(error));
			return { oauth: "missing-bundled-flow", provider: provider.id, loaded, mode };
		}
	}
	assert.notEqual(mode, "bundled", "If upstream becomes bundle-safe, update the documented packaging limitation");
	const sdks = [];
	for (const id of ["openai", "anthropic", "google", "deepseek"]) {
		const provider = providers.find((provider) => provider.id === id);
		const model = provider.getModels()[0];
		const models = createModels(); models.setProvider(provider);
		const result = await models.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: 1 }] }, {
			apiKey: "p0-fake-key", maxTokens: 64, maxRetries: 0, signal: AbortSignal.timeout(5000),
			onPayload: () => { sdks.push(id); throw new Error("P0_PAYLOAD_CAPTURED_NO_NETWORK"); },
		});
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /P0_PAYLOAD_CAPTURED_NO_NETWORK/);
	}
	const callback = await probeOpenAICallback(providers.find((provider) => provider.id === "openai"));
	return { mode, oauth: loaded, lazySDKs: sdks, callback, platform: process.platform, electron: process.versions.electron };
}

// Do not await readiness at module top level: Electron waits for ESM evaluation
// before emitting ready, so top-level await here would deadlock startup.
app.whenReady().then(probe).then((result) => {
	console.log(`LOOM_CHAT_PROBE=${JSON.stringify(result)}`);
	app.exit(0);
}, (error) => {
	console.error(error);
	app.exit(1);
});
