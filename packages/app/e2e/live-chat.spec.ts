import { expect, saveChatEndpoint, test } from "./loom.ts";

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
