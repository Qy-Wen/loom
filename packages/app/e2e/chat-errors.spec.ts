import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("run errors are visible, stay scoped to the session, and clear on retry", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated settings and library required");
	await expect(loomPage.getByRole("textbox")).toBeVisible();
	const before = await loomPage.evaluate(async () => {
		await window.loom.saveChatSettings({ version: 1, providers: [] });
		return window.loom.listSessions();
	});
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
	const sessionId = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((old) => old.id === row.id))!.id;
	const runError = loomPage.waitForResponse(async (response) => {
		if (!response.url().includes("/run")) return false;
		return (await response.text()).includes('"message":"no_model"');
	});
	await loomPage.getByRole("textbox").fill("Question without a model");
	await loomPage.getByRole("textbox").press("Enter");
	await runError;
	const alert = loomPage.getByRole("alert").filter({ hasText: "no_model" });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText("Choose a conversation model");
	await expect(loomPage.getByRole("button", { name: "Conversation model", exact: true })).toBeEnabled();
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect(alert).toHaveCount(0);
	await loomPage.getByRole("tab", { name: "Question without a model", exact: true }).click();
	await expect(loomPage.getByRole("tab", { name: "Question without a model", selected: true, exact: true })).toBeVisible();
	await expect(alert).toHaveCount(0);

	const reply = Promise.withResolvers<void>();
	const requested = Promise.withResolvers<void>();
	const server = createServer((_request, response) => {
		requested.resolve();
		void reply.promise.then(() => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end('data: {"id":"reply","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"RETRY_SUCCEEDED"},"finish_reason":null}]}\n\ndata: {"id":"reply","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		// Reproduce the failure again before retrying in the same session.
		await loomPage.getByRole("textbox").fill("Still no model");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(alert).toBeVisible();
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.evaluate((id) => window.loom.setSessionModel(id, { provider: "e2e-chat", modelId: "demo", thinkingLevel: "off" }), sessionId);
		await loomPage.getByRole("textbox").fill("Retry after choosing a model");
		await loomPage.getByRole("textbox").press("Enter");
		await requested.promise;
		await expect(alert).toHaveCount(0);
		reply.resolve();
		await expect(loomPage.getByText("RETRY_SUCCEEDED", { exact: true })).toBeVisible();
	} finally {
		reply.resolve();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("transport failures appear even without a RUN_ERROR event", async ({ loomPage }) => {
	await expect(loomPage.getByRole("textbox")).toBeVisible();
	await loomPage.route("**/api/copilotkit/agent/loom/run", (route) => route.abort("connectionfailed"));
	try {
		await loomPage.getByRole("textbox").fill("Question over a broken connection");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.locator(".chat-error[role=alert]")).toBeVisible();
		await expect(loomPage.locator(".chat-error-body")).toContainText(/network|fetch/i);
		await expect(loomPage.getByRole("button", { name: "Conversation model", exact: true })).toBeEnabled();
	} finally {
		await loomPage.unroute("**/api/copilotkit/agent/loom/run");
	}
});

test("a rejected key shows one error, with the explanation once", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated settings and library required");
	const server = createServer((_request, response) => {
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ message: "Authentication Fails, Your api key: ****7a01 is invalid", type: "authentication_error" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("textbox").fill("hello");
		await loomPage.getByRole("textbox").press("Enter");
		const errors = loomPage.locator(".chat-error[role=alert]");
		await expect(errors.first()).toBeVisible();
		// The failure reaches history and the live copy gives way to it: one box, not two.
		await expect(loomPage.getByTestId("copilot-assistant-message")).toHaveCount(0);
		await expect(errors).toHaveCount(1);
		await loomPage.waitForTimeout(1500);
		await expect(errors).toHaveCount(1);
		const body = (await errors.locator(".chat-error-body").innerText());
		expect(body.match(/API key was rejected/g)).toHaveLength(1);
		expect(body).toContain("****7a01");
		// The error stays after the session is reloaded from history.
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await loomPage.getByRole("tab", { name: "hello", exact: true }).click();
		await expect(errors).toHaveCount(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
