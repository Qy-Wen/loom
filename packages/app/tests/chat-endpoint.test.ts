import assert from "node:assert/strict";
import { test } from "node:test";
import { chatEndpointUrl, ChatEndpointError, detectChatEndpoint, parseChatEndpoint } from "../src/shared/chat-endpoint.ts";
import { buildCustomProvider, customProviderDraft, CustomDraftError } from "../src/renderer/settings/chat-custom-draft.ts";

for (const [url, api, baseUrl] of [
	["https://proxy.example.com/v1/chat/completions", "openai-completions", "https://proxy.example.com/v1"],
	["https://proxy.example.com/api/v2/responses", "openai-responses", "https://proxy.example.com/api/v2"],
	["https://proxy.example.com/responses", "openai-responses", "https://proxy.example.com"],
	["https://proxy.example.com/prefix/v1/messages?beta=true", "anthropic-messages", "https://proxy.example.com/prefix"],
	["https://proxy.example.com/v1/messages", "anthropic-messages", "https://proxy.example.com"],
	["http://localhost:1234/v1beta/models/gemini-demo:streamGenerateContent?alt=sse", "google-generative-ai", "http://localhost:1234/v1beta"],
] as const) test(`detects ${api} from the operation path, preserving its base prefix`, () => {
	const endpoint = parseChatEndpoint(` ${url} `);
	assert.equal(endpoint.api, api); assert.equal(endpoint.baseUrl, baseUrl);
	if (api === "google-generative-ai") assert.equal(endpoint.modelId, "gemini-demo");
	assert.deepEqual(parseChatEndpoint(chatEndpointUrl(baseUrl, api, endpoint.modelId)), endpoint);
	const draft = customProviderDraft(); draft.requestUrl = url; draft.models[0]!.id = "demo";
	const built = buildCustomProvider("custom-test", draft);
	assert.equal(built.api, api); assert.equal(built.baseUrl, baseUrl);
	assert.equal(customProviderDraft(built).requestUrl, chatEndpointUrl(baseUrl, api, "demo"));
});

test("Gemini model resource prefixes are not duplicated when displaying the full URL", () => {
	assert.equal(chatEndpointUrl("https://example.com/v1beta", "google-generative-ai", "models/gemini-demo"), "https://example.com/v1beta/models/gemini-demo:streamGenerateContent?alt=sse");
});

test("unknown paths and non-native versions are not guessed from hostname or query", () => {
	for (const url of ["https://api.openai.com/inference", "https://example.com/v2/messages", "https://example.com/other?path=/responses"]) {
		assert.equal(detectChatEndpoint(url), undefined);
		assert.throws(() => parseChatEndpoint(url), (error) => error instanceof ChatEndpointError && error.code === "protocol");
	}
});

test("unsupported query flags and secret-bearing URLs are rejected, not silently stripped", () => {
	for (const url of ["https://example.com/v1/responses?region=cn", "https://example.com/v1/messages?beta=false", "https://example.com/v1beta/models/m:streamGenerateContent?key=PRIVATE"]) {
		assert.throws(() => parseChatEndpoint(url), (error) => error instanceof ChatEndpointError && error.code === "query" && !error.message.includes("PRIVATE"));
	}
	for (const url of ["", "file:///v1/chat/completions", "https://user:PRIVATE@example.com/v1/responses", "https://example.com/v1/responses#PRIVATE"]) {
		assert.throws(() => parseChatEndpoint(url), (error) => error instanceof ChatEndpointError && error.code === "url" && !error.message.includes("PRIVATE"));
	}
});

test("base URL mode is explicit and retains pi-ai's native protocol semantics", () => {
	const draft = customProviderDraft(); draft.requestUrl = "https://proxy.example.com/prefix"; draft.models[0]!.id = "demo";
	assert.throws(() => buildCustomProvider("custom-test", draft), (error) => error instanceof CustomDraftError && error.code === "protocol");
	draft.manualApi = "openai-responses";
	const built = buildCustomProvider("custom-test", draft);
	assert.equal(built.api, "openai-responses"); assert.equal(built.baseUrl, draft.requestUrl);
	assert.equal(customProviderDraft(built).requestUrl, "https://proxy.example.com/prefix/responses");
	draft.requestUrl = "https://proxy.example.com/prefix?key=PRIVATE";
	assert.throws(() => buildCustomProvider("custom-test", draft), (error) => error instanceof CustomDraftError && error.code === "baseUrl" && !error.message.includes("PRIVATE"));
});
