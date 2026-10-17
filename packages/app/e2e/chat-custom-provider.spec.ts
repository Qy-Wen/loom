import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

/** Configure entirely through the UI; do not bypass the form or credential prompt with saveChatSettings. */
test("custom provider can be created, authenticated, edited and used for streaming through Settings", async ({ loomPage, electronApp }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	test.setTimeout(60_000);
	const key = "CUSTOM_UI_TEST_KEY";
	const requests: { model: string; authorization?: string; url?: string }[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { model: string };
			requests.push({ model: parsed.model, authorization: request.headers.authorization, url: request.url });
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = { id: "custom-ui", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: { content: "CUSTOM_UI_STREAM_OK" }, finish_reason: "stop" }] };
			response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		const before = await loomPage.evaluate(async () => (await window.loom.getChatSettings()).config.providers.length);
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.getByRole("dialog", { name: "Settings", exact: true });
		await expect(settings.getByRole("button", { name: "Custom provider", exact: true })).toHaveCount(0);
		await settings.getByRole("combobox", { name: "Add provider", exact: true }).selectOption("__custom__");
		const editor = settings.getByRole("group", { name: "Add custom provider", exact: true });
		await expect(editor).toBeVisible();
		expect(await loomPage.evaluate(async () => (await window.loom.getChatSettings()).config.providers.length)).toBe(before);
		await editor.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(editor.getByRole("alert")).toContainText("Enter a complete HTTP(S) request URL");
		await editor.getByRole("textbox", { name: "Provider name (optional)", exact: true }).fill("Local UI provider");
		const urlInput = editor.getByRole("textbox", { name: "Request URL", exact: true });
		await expect(urlInput).toHaveAttribute("placeholder", "https://api.example.com/v1/chat/completions");
		for (const [suffix, protocol] of [
			["/messages?beta=true", "Anthropic Messages"],
			["/models/gemini-demo:streamGenerateContent?alt=sse", "Google Gemini"],
			["/responses", "OpenAI Responses"],
			["/chat/completions", "OpenAI Chat Completions"],
		]) {
			await urlInput.fill(baseUrl + suffix);
			await expect(editor.getByRole("status")).toHaveText(`Protocol: ${protocol}`);
			await expect(editor.getByRole("combobox", { name: "Protocol", exact: true })).toHaveCount(0);
		}
		await urlInput.fill(baseUrl + "/inference");
		await editor.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(editor.getByRole("alert")).toContainText("Cannot identify the protocol");
		await editor.getByRole("button", { name: "Use Base URL instead", exact: true }).click();
		await expect(editor.getByRole("textbox", { name: "Base URL", exact: true })).toHaveValue(baseUrl + "/inference");
		await editor.getByRole("combobox", { name: "Protocol", exact: true }).selectOption("openai-responses");
		await editor.getByRole("button", { name: "Use full request URL", exact: true }).click();
		await expect(urlInput).toHaveValue(baseUrl + "/inference/responses");
		await expect(editor.getByRole("combobox", { name: "Protocol", exact: true })).toHaveCount(0);
		await urlInput.fill(baseUrl + "/chat/completions");
		const first = editor.getByRole("group", { name: "Model 1", exact: true });
		await first.getByRole("textbox", { name: "Model id", exact: true }).fill("first");
		await first.getByRole("textbox", { name: "Display name (optional)", exact: true }).fill("First custom model");
		await first.getByText("Advanced", { exact: true }).click();
		await first.getByRole("spinbutton", { name: "Context window", exact: true }).fill("32000");
		await first.getByRole("spinbutton", { name: "Maximum output tokens", exact: true }).fill("2048");
		const limitsLayout = await first.locator(".settings-chat-custom-limits").evaluate((element) => {
			const [context, output] = Array.from(element.querySelectorAll("input")).map((input) => input.getBoundingClientRect());
			return { topDelta: Math.abs(context!.top - output!.top), heightDelta: Math.abs(context!.height - output!.height) };
		});
		expect(limitsLayout.topDelta).toBeLessThan(1);
		expect(limitsLayout.heightDelta).toBeLessThan(1);
		await first.getByRole("checkbox", { name: "Supports image input", exact: true }).check();
		await editor.getByRole("button", { name: "Add model", exact: true }).click();
		const second = editor.getByRole("group", { name: "Model 2", exact: true });
		await second.getByRole("textbox", { name: "Model id", exact: true }).fill("first");
		await editor.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(editor.getByRole("alert")).toContainText("unique model ID");
		await second.getByRole("textbox", { name: "Model id", exact: true }).fill("backup");
		await editor.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(editor).toHaveCount(0);
		const provider = settings.locator(".settings-chat-provider").filter({ has: loomPage.getByText("Local UI provider", { exact: true }) });
		await expect(provider.getByRole("switch", { name: "Enable First custom model", exact: true })).toBeChecked();
		const saved = await loomPage.evaluate(async () => (await window.loom.getChatSettings()).config.providers.find((entry) => entry.name === "Local UI provider"));
		expect(saved?.kind).toBe("custom");
		if (saved?.kind !== "custom") throw new Error("Custom provider missing");
		expect(saved.api).toBe("openai-completions"); expect(saved.baseUrl).toBe(baseUrl);
		expect(saved.models.map((model) => model.id)).toEqual(["first", "backup"]);
		expect(saved.models[0]!.input).toEqual(["text", "image"]);
		expect(saved.models[0]!.contextWindow).toBe(32000);
		expect(saved.models[0]!.maxTokens).toBe(2048);

		await provider.locator(".settings-chat-provider-actions").getByRole("button", { name: "API key", exact: true }).click();
		const login = loomPage.getByRole("dialog", { name: "Provider sign-in", exact: true });
		const keyInput = login.getByLabel("API key", { exact: true });
		await expect(keyInput).toHaveAttribute("type", "password");
		await expect(keyInput).toHaveValue("");
		await keyInput.focus();
		const secretFocusStyle = await keyInput.evaluate((input) => ({
			innerShadow: getComputedStyle(input).boxShadow,
			innerBorder: getComputedStyle(input).borderRightWidth,
			outerShadow: getComputedStyle(input.parentElement!).boxShadow,
		}));
		expect(secretFocusStyle.innerShadow).toBe("none");
		expect(secretFocusStyle.innerBorder).toBe("0px");
		expect(secretFocusStyle.outerShadow).not.toBe("none");
		await keyInput.fill(key);
		await login.getByRole("button", { name: "Show API key", exact: true }).click();
		await expect(keyInput).toHaveAttribute("type", "text");
		await expect(keyInput).toHaveValue(key);
		await login.getByRole("button", { name: "Hide API key", exact: true }).click();
		await expect(keyInput).toHaveAttribute("type", "password");
		await expect(login.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
		const loginButtonLayout = await login.locator(".settings-login-actions").evaluate((element) => {
			const [cancel, proceed] = Array.from(element.querySelectorAll("button")).map((button) => button.getBoundingClientRect());
			return { topDelta: Math.abs(proceed!.top - cancel!.top), heightDelta: Math.abs(proceed!.height - cancel!.height), rightAligned: proceed!.left > cancel!.right };
		});
		expect(loginButtonLayout.topDelta).toBeLessThan(1);
		expect(loginButtonLayout.heightDelta).toBeLessThan(1);
		expect(loginButtonLayout.rightAligned).toBe(true);
		await login.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(login).toBeHidden();
		await expect(provider.locator(".settings-probe.is-ok")).toBeVisible();
		await provider.locator(".settings-chat-provider-actions").getByRole("button", { name: "API key", exact: true }).click();
		await expect(keyInput).toHaveValue(key);
		await expect(keyInput).toHaveAttribute("type", "password");
		await login.getByRole("button", { name: "Show API key", exact: true }).click();
		await expect(keyInput).toHaveAttribute("type", "text");
		await keyInput.fill("discarded-replacement");
		await loomPage.evaluate(() => {
			const scope = window as typeof window & { cancelErrorObserver?: MutationObserver; cancelErrors?: string[] };
			scope.cancelErrors = [];
			scope.cancelErrorObserver = new MutationObserver((records) => {
				for (const record of records) for (const node of record.addedNodes) {
					if (!(node instanceof Element)) continue;
					if (node.matches(".session-error")) scope.cancelErrors!.push(node.textContent ?? "");
					for (const error of node.querySelectorAll(".session-error")) scope.cancelErrors!.push(error.textContent ?? "");
				}
			});
			scope.cancelErrorObserver.observe(document.querySelector(".settings-chat-form")!, { childList: true, subtree: true });
		});
		await login.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(login).toBeHidden();
		await expect(provider.locator(".settings-chat-provider-actions").getByRole("button", { name: "API key", exact: true })).toBeEnabled();
		const cancelErrors = await loomPage.evaluate(() => {
			const scope = window as typeof window & { cancelErrorObserver?: MutationObserver; cancelErrors?: string[] };
			scope.cancelErrorObserver?.disconnect();
			const errors = scope.cancelErrors ?? [];
			delete scope.cancelErrorObserver; delete scope.cancelErrors;
			return errors;
		});
		expect(cancelErrors).toEqual([]);
		await provider.locator(".settings-chat-provider-actions").getByRole("button", { name: "API key", exact: true }).click();
		await expect(keyInput).toHaveValue(key);
		await expect(keyInput).toHaveAttribute("type", "password");
		await login.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(login).toBeHidden();
		expect(JSON.stringify(await loomPage.evaluate(() => window.loom.getChatSettings()))).not.toContain(key);
		const userData = await electronApp!.evaluate(({ app }) => app.getPath("userData"));
		for (const file of ["chat-models.json", "chat-credentials.json"]) expect(await readFile(join(userData, file), "utf8")).not.toContain(key);

		await provider.locator(".settings-chat-provider-actions").getByRole("button", { name: "Edit", exact: true }).click();
		const edit = provider.getByRole("group", { name: "Edit custom provider", exact: true });
		await expect(edit.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue(baseUrl + "/chat/completions");
		await edit.getByRole("group", { name: "Model 2", exact: true }).getByRole("button", { name: "Remove model", exact: true }).click();
		await edit.getByRole("textbox", { name: "Request URL", exact: true }).fill(baseUrl + "/edited/chat/completions");
		await edit.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(edit).toHaveCount(0);
		const updated = await loomPage.evaluate(async (id) => (await window.loom.getChatSettings()).config.providers.find((entry) => entry.id === id), saved.id);
		expect(updated?.kind).toBe("custom");
		if (updated?.kind !== "custom") throw new Error("Edited provider missing");
		expect(updated.baseUrl).toBe(baseUrl + "/edited"); expect(updated.models).toHaveLength(1);
		await expect(provider.locator(".settings-probe.is-ok")).toBeVisible();
		await settings.getByRole("button", { name: "Close settings" }).click();
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await loomPage.getByRole("button", { name: "Conversation model", exact: true }).click();
		await loomPage.getByRole("menuitemradio", { name: `First custom model (${saved.id})`, exact: true }).click();
		await loomPage.getByRole("textbox").fill("Reply directly without using tools.");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByTestId("copilot-message-list").getByText("CUSTOM_UI_STREAM_OK", { exact: true })).toBeVisible();
		expect(requests).toEqual([{ model: "first", authorization: `Bearer ${key}`, url: "/v1/edited/chat/completions" }]);
		await loomPage.reload();
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(provider.locator(".settings-probe.is-ok")).toBeVisible();
		await provider.locator(".settings-chat-provider-actions").getByRole("button", { name: "Edit", exact: true }).click();
		await expect(edit.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue(baseUrl + "/edited/chat/completions");
		await edit.getByRole("button", { name: "Cancel", exact: true }).click();
		await provider.locator(".settings-chat-provider-actions").getByRole("button", { name: "Remove", exact: true }).click();
		await expect(provider).toHaveCount(0);
		await settings.getByRole("button", { name: "Close settings" }).click();
	} finally {
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
