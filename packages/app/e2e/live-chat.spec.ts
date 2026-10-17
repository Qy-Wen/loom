import { expect, saveChatEndpoint, test } from "./loom.ts";

test("native DeepSeek provider completes two turns with persisted model selection and usage", async ({ loomPage }) => {
	test.skip(process.env.LOOM_E2E_LIVE_CHAT !== "1", "set LOOM_E2E_LIVE_CHAT=1 to run live acceptance");
	test.setTimeout(120_000);
	await loomPage.evaluate(async () => {
		const view = await window.loom.getChatSettings();
		const provider = view.config.providers.find((row) => row.id === "deepseek");
		if (!provider || !view.models.some((row) => row.provider === "deepseek" && row.id === "deepseek-flash" && row.available)) throw new Error("Native DeepSeek credentials and model are required");
		provider.enabled = true;
		provider.generation = { maxTokens: 64 };
		await window.loom.saveChatSettings({ ...view.config, default: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off" } });
	});
	const before = await loomPage.evaluate(() => window.loom.listSessions());
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	const id = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((old) => old.id === row.id))!.id;
	for (const marker of ["NATIVE_DEEPSEEK_FIRST_OK", "NATIVE_DEEPSEEK_SECOND_OK"]) {
		await loomPage.getByRole("textbox").fill(`Reply only with ${marker}. Do not use tools.`);
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByTestId("copilot-message-list").getByText(marker, { exact: true })).toBeVisible({ timeout: 45_000 });
		await expect(loomPage.getByRole("button", { name: "Conversation model", exact: true })).toBeEnabled();
	}
	const record = await loomPage.evaluate((sessionId) => window.loom.getSession(sessionId), id);
	expect(record.messages.filter((row) => row.role === "user")).toHaveLength(2);
	expect(record.messages.filter((row) => row.role === "assistant")).toHaveLength(2);
	expect(record.model).toEqual({ provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off" });
	expect(record.context?.tokens).toBeGreaterThan(0);
	await loomPage.reload();
	await expect(loomPage.getByTestId("copilot-message-list").getByText("NATIVE_DEEPSEEK_SECOND_OK", { exact: true })).toBeVisible();
	expect((await loomPage.evaluate((sessionId) => window.loom.getSession(sessionId), id)).model).toEqual(record.model);
});

/** Optional live acceptance; never log the key or request payload. */
test("real Chat model streams both first and subsequent turns before RUN_FINISHED", async ({ loomPage }) => {
	test.skip(process.env.LOOM_E2E_LIVE_CHAT !== "1", "set LOOM_E2E_LIVE_CHAT=1 and load Chat credentials");
	test.setTimeout(150_000);
	const chat = {
		baseUrl: process.env.LOOM_CHAT_BASE_URL?.trim() || "https://api.deepseek.com",
		model: process.env.LOOM_CHAT_MODEL?.trim() || "deepseek-chat",
		apiKey: process.env.LOOM_CHAT_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim(),
	};
	if (!chat.apiKey) throw new Error("A Chat API key is required for live acceptance");
	await saveChatEndpoint(loomPage, chat.baseUrl, { model: chat.model });
	// Feed the API key into the custom provider's login prompt automatically.
	await loomPage.evaluate(async (apiKey) => {
		const answer = new Promise<void>((resolve) => {
			const unsubscribe = window.loom.onChatLoginPrompt((prompt) => {
				if (prompt.type === "secret") { void window.loom.chatLoginResponse(apiKey); resolve(); }
			});
			setTimeout(() => { unsubscribe(); resolve(); }, 10_000);
		});
		const login = window.loom.chatLogin("e2e-chat", "api_key");
		await answer; await login;
		const original = window.fetch;
		const progress = { finished: false, partialBeforeFinish: false };
		(window as unknown as { liveProgress: typeof progress }).liveProgress = progress;
		window.fetch = async (...args) => {
			const response = await original(...args);
			const target = args[0];
			const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
			// Idle connect emits its own RUN_FINISHED; it is not the model run being measured.
			if (new URL(url, window.location.href).pathname.endsWith("/run") && response.headers.get("content-type")?.includes("text/event-stream")) {
				const reader = response.clone().body!.getReader();
				void (async () => {
					const decoder = new TextDecoder();
					let pending = "";
					for (;;) {
						const { done, value } = await reader.read(); if (done) break;
						pending += decoder.decode(value, { stream: true });
						const lines = pending.split("\n"); pending = lines.pop()!;
						for (const line of lines) {
							if (!line.startsWith("data: ")) continue;
							try {
								const event = JSON.parse(line.slice(6)) as { type: string };
								if (event.type === "RUN_FINISHED") progress.finished = true;
								if (event.type === "TEXT_MESSAGE_CONTENT" && !progress.finished) progress.partialBeforeFinish = true;
							} catch { /* Keepalive comments are not events. */ }
						}
					}
				})();
			}
			return response;
		};
	}, chat.apiKey);
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
	const count = (await loomPage.evaluate(() => window.loom.listSessions())).length;
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(count + 1);
	await expect(loomPage.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
	const composer = loomPage.getByRole("textbox");
	for (let turn = 0; turn < 2; turn++) {
		await loomPage.evaluate(() => {
			const progress = (window as unknown as { liveProgress: { finished: boolean; partialBeforeFinish: boolean } }).liveProgress;
			progress.finished = false; progress.partialBeforeFinish = false;
		});
		const marker = `LOOM_STREAM_CHECK_${turn}`;
		await composer.fill(`Do not use any tools. Start your answer with ${marker}. Then write 40 numbered sentences explaining how to organize creative assets. Write the answer directly, not into a file.`);
		await composer.press("Enter");
		await expect(loomPage.getByTestId("copilot-message-list").getByText(new RegExp(`^${marker}`)).last()).toBeVisible({ timeout: 60_000 });
		await expect.poll(() => loomPage.evaluate(() => (window as unknown as { liveProgress: { partialBeforeFinish: boolean } }).liveProgress.partialBeforeFinish)).toBe(true);
		const progress = await loomPage.evaluate(() => (window as unknown as { liveProgress: { finished: boolean; partialBeforeFinish: boolean } }).liveProgress);
		expect(progress.partialBeforeFinish).toBe(true);
		expect(progress.finished).toBe(false);
		await expect.poll(async () => loomPage.evaluate(() => (window as unknown as { liveProgress: { finished: boolean } }).liveProgress.finished), { timeout: 60_000 }).toBe(true);
	}
});
