import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	createHttpVideoVlmProvider,
	createHttpVlmProvider,
	parseVlmResponse,
	resetNativeVideoProbeForTests,
	shouldFallbackFromNativeVideo,
	vlmChatUrl,
	vlmFrameRequestBody,
	vlmRequestBody,
	vlmVideoRequestBody,
} from "../src/main/vlm-provider.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetNativeVideoProbeForTests();
});

test("vlmChatUrl appends /v1/chat/completions", () => {
	assert.equal(vlmChatUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1/chat/completions");
	assert.equal(vlmChatUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1/chat/completions");
	assert.equal(vlmChatUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
	assert.equal(vlmChatUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/chat/completions");
});

test("createHttpVlmProvider posts OpenAI chat/completions with image_url", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({
			choices: [{ message: { content: "## Caption\nGreen.\n" } }],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpVlmProvider({
		baseUrl: "http://127.0.0.1:1234",
		apiKey: "",
		model: "qwen/qwen3-vl-4b",
	});
	const text = await provider.describe({ filename: "shot.jpg", bytes: new Uint8Array([9]) });
	assert.match(text, /Green/);
	assert.equal(calls[0]?.url, "http://127.0.0.1:1234/v1/chat/completions");
	const headers = new Headers(calls[0]?.init.headers);
	assert.equal(headers.get("authorization"), null);
	const body = JSON.parse(String(calls[0]?.init.body)) as {
		model: string;
		messages: Array<{ role: string; content: unknown }>;
	};
	assert.equal(body.model, "qwen/qwen3-vl-4b");
	assert.equal(body.messages[0]?.role, "system");
	const content = body.messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
	assert.equal(content.some((part) => part.type === "image_url" && part.image_url?.url.startsWith("data:image/jpeg;base64,")), true);
});

test("createHttpVlmProvider sends a Bearer key for remote APIs", async () => {
	globalThis.fetch = (async (_url, init) => {
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer secret");
		return new Response(JSON.stringify({
			choices: [{ message: { content: "ok" } }],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpVlmProvider({
		baseUrl: "https://api.example.com/v1",
		apiKey: "secret",
		model: "gpt-4o-mini",
	});
	assert.equal(await provider.describe({ filename: "shot.png", bytes: new Uint8Array([1]) }), "ok");
});

test("parseVlmResponse reads OpenAI choices", () => {
	assert.equal(
		parseVlmResponse(JSON.stringify({ choices: [{ message: { content: "Hello" } }] })),
		"Hello",
	);
	assert.equal(
		parseVlmResponse(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "Hi" }] } }] })),
		"Hi",
	);
});

test("vlmRequestBody uses chat completions image_url parts", () => {
	const body = vlmRequestBody("gpt-4o", "data:image/png;base64,xx");
	assert.ok(Array.isArray(body.messages));
});

test("shouldFallbackFromNativeVideo treats schema errors as frames", () => {
	assert.equal(shouldFallbackFromNativeVideo(400, "unknown type video_url"), true);
	assert.equal(shouldFallbackFromNativeVideo(401, "unauthorized"), false);
	assert.equal(shouldFallbackFromNativeVideo(500, "oom"), true);
});

test("createHttpVideoVlmProvider posts video_url then falls back to stills", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		if (calls.length === 1) {
			return new Response("unknown type video_url", { status: 400 });
		}
		return new Response(JSON.stringify({
			choices: [{ message: { content: "## Caption\nFrom stills.\n" } }],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpVideoVlmProvider({
		baseUrl: "http://127.0.0.1:1234",
		apiKey: "",
		model: "qwen/qwen3-vl-4b",
	});
	let extracted = 0;
	const text = await provider.describe({
		native: { filename: "clip.mp4", bytes: new Uint8Array([9]) },
		frames: async () => {
			extracted += 1;
			return [{ filename: "frame-0.jpg", bytes: new Uint8Array([1]) }];
		},
	});
	assert.match(text, /From stills/);
	assert.equal(extracted, 1);
	assert.equal(calls.length, 2);
	const nativeBody = JSON.parse(String(calls[0]?.init.body)) as {
		messages: Array<{ content: Array<{ type: string }> }>;
	};
	assert.equal(nativeBody.messages[1]?.content.some((part) => part.type === "video_url"), true);
	const frameBody = JSON.parse(String(calls[1]?.init.body)) as {
		messages: Array<{ content: Array<{ type: string }> }>;
	};
	assert.equal(frameBody.messages[1]?.content.some((part) => part.type === "image_url"), true);
});

test("createHttpVideoVlmProvider uses native video when the endpoint accepts it", async () => {
	globalThis.fetch = (async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as {
			messages: Array<{ content: Array<{ type: string; video_url?: { url: string } }> }>;
		};
		assert.equal(body.messages[1]?.content.some((part) => (
			part.type === "video_url" && part.video_url?.url.startsWith("data:video/mp4;base64,")
		)), true);
		return new Response(JSON.stringify({
			choices: [{ message: { content: "## Caption\nNative.\n" } }],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpVideoVlmProvider({
		baseUrl: "http://127.0.0.1:1234",
		apiKey: "",
		model: "qwen/qwen3-vl-4b",
	});
	const text = await provider.describe({
		native: { filename: "clip.mp4", bytes: new Uint8Array([9]) },
		frames: async () => {
			throw new Error("should not extract");
		},
	});
	assert.match(text, /Native/);
});

test("vlmVideoRequestBody and vlmFrameRequestBody use the video prompt", () => {
	const native = vlmVideoRequestBody("qwen/qwen3-vl-4b", "data:video/mp4;base64,xx");
	assert.ok(Array.isArray(native.messages));
	const frames = vlmFrameRequestBody("qwen/qwen3-vl-4b", [{ filename: "frame-0.jpg", bytes: new Uint8Array([1]) }]);
	assert.ok(Array.isArray(frames.messages));
});
