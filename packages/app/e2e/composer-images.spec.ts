import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, saveChatEndpoint, test } from "./loom.ts";

type ContentPart = { type: string; text?: string; image_url?: { url: string } };
type Request = { messages: { role: string; content: string | ContentPart[] }[] };
const fixture = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);

function reply(response: ServerResponse, text: string, finish = true): void {
	if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "composer", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
	response.write(chunk({ content: text }, null));
	if (finish) response.end(chunk({}, "stop") + "data: [DONE]\n\n");
}

async function pasteImage(page: Page, data: string, kind: "paste" | "drop" = "paste"): Promise<void> {
	await page.getByTestId("copilot-chat-textarea").evaluate((editor, { data, kind }) => {
		const file = new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "clipboard.png", { type: "image/png" });
		const transfer = new DataTransfer(); transfer.items.add(file);
		editor.dispatchEvent(kind === "paste"
			? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
			: new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
	}, { data, kind });
	await expect(page.getByTestId("copilot-chat-textarea").locator("[data-asset-id]")).toHaveCount(1);
}

function lastUser(request: Request) {
	return request.messages.findLast((message) => message.role === "user")!;
}

for (const source of ["paste", "drop", "library", "external"] as const) {
	test(`composer ${source} sends an image and its library reference directly, then plain text sends no stale image`, async ({ loomPage, electronApp }) => {
		test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
		const data = (await readFile(fixture)).toString("base64");
		const requests: Request[] = [];
		const server = createServer((request, response) => {
			let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => { requests.push(JSON.parse(body)); reply(response, `COMPOSER_${source}_${requests.length}`); });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const temp = await mkdtemp(join(tmpdir(), "loom-composer-e2e-"));
		try {
			await expect(loomPage.locator(".shell")).toBeVisible();
			await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { input: ["text", "image"] });
			const before = await loomPage.evaluate(() => window.loom.listSessions());
			await loomPage.getByRole("button", { name: "New session", exact: true }).click();
			await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
			const session = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((old) => old.id === row.id))!;
			if (source === "paste" || source === "drop") await pasteImage(loomPage, data, source);
			else {
				const root = await loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
				const path = join(source === "library" ? root! : temp, `composer-${source}.png`);
				await copyFile(fixture, path);
				if (source === "library") await loomPage.evaluate((path) => window.loom.importComposerFiles([path]), path);
				await electronApp!.evaluate(({ dialog }, path) => {
					const original = dialog.showOpenDialog;
					dialog.showOpenDialog = (async () => {
						dialog.showOpenDialog = original;
						return { canceled: false, filePaths: [path] };
					}) as typeof dialog.showOpenDialog;
				}, path);
				await loomPage.getByRole("button", { name: "Add", exact: true }).click();
				await loomPage.getByRole("menuitem", { name: source === "library" ? "Library file" : "External file", exact: true }).click();
				await expect(loomPage.getByTestId("copilot-chat-textarea").locator("[data-asset-id]")).toHaveCount(1);
			}
			const assetId = await loomPage.getByTestId("copilot-chat-textarea").locator("[data-asset-id]").getAttribute("data-asset-id");
			await expect(loomPage.getByRole("status").filter({ hasText: "does not accept images" })).toHaveCount(0);
			await loomPage.getByTestId("copilot-chat-textarea").press("Enter");
			await expect(loomPage.getByText(`COMPOSER_${source}_1`, { exact: true }).first()).toBeVisible();
			expect(requests).toHaveLength(1);
			expect(lastUser(requests[0]!).content).toEqual(expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining(`asset_id: ${assetId}`) }),
				{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
			]));
			const snapshot = await loomPage.evaluate(() => window.loom.getLibrarySnapshot());
			expect(snapshot.assets.some((asset) => asset.assetId === assetId)).toBe(true);
			const record = await loomPage.evaluate((id) => window.loom.getSession(id), session.id);
			const user = record.messages.find((message) => message.role === "user")!;
			expect(user.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", url: expect.stringContaining("loom-asset://chat-image/") })]));
			expect(JSON.stringify(user.content)).not.toContain(data);
			await loomPage.getByTestId("copilot-chat-textarea").fill("plain next turn");
			await loomPage.getByTestId("copilot-chat-textarea").press("Enter");
			await expect(loomPage.getByText(`COMPOSER_${source}_2`, { exact: true }).first()).toBeVisible();
			expect(JSON.stringify(lastUser(requests[1]!).content)).not.toContain("image_url");
			await loomPage.reload();
			await expect(loomPage.getByText(`COMPOSER_${source}_2`, { exact: true }).first()).toBeVisible();
			expect(requests).toHaveLength(2);
			if (source === "paste") {
				// Editing an image question forks and reconstructs chips from stored text.
				const bubble = loomPage.getByTestId("copilot-user-message").first();
				await bubble.hover();
				await bubble.getByRole("button", { name: "Edit", exact: true }).click();
				await loomPage.locator(".session-inline-edit-send").click();
				await expect(loomPage.getByText(`COMPOSER_${source}_3`, { exact: true }).first()).toBeVisible();
				expect(lastUser(requests[2]!).content).toEqual(expect.arrayContaining([{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }]));
				const editedBubble = loomPage.getByTestId("copilot-user-message").first();
				await editedBubble.hover();
				await editedBubble.getByRole("button", { name: "Edit", exact: true }).click();
				const editor = loomPage.locator(".session-inline-edit");
				await editor.locator(".session-asset-chip-remove").click();
				await expect(editor.locator(".session-inline-edit-send")).toBeDisabled();
				await editor.getByRole("textbox", { name: "Edit question", exact: true }).fill("edited without image");
				await editor.locator(".session-inline-edit-send").click();
				await expect(loomPage.getByText(`COMPOSER_${source}_4`, { exact: true })).toBeVisible();
				expect(JSON.stringify(lastUser(requests[3]!).content)).not.toContain("image_url");
				expect(JSON.stringify(lastUser(requests[3]!).content)).not.toContain("<asset_ref>");
			}
		} finally {
			await rm(temp, { recursive: true, force: true });
			server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
}

test("a text-only model keeps the library reference and receives an omitted-image placeholder", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const data = (await readFile(fixture)).toString("base64");
	const requests: Request[] = [];
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => { requests.push(JSON.parse(body)); reply(response, "COMPOSER_TEXT_ONLY"); });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await expect(loomPage.getByRole("status").filter({ hasText: "does not accept images" })).toHaveCount(0);
		await pasteImage(loomPage, data);
		await expect(loomPage.getByRole("status").filter({ hasText: "does not accept images" })).toBeVisible();
		await loomPage.getByTestId("copilot-chat-textarea").press("Enter");
		await expect(loomPage.getByText("COMPOSER_TEXT_ONLY", { exact: true })).toBeVisible();
		await expect(loomPage.getByRole("status").filter({ hasText: "does not accept images" })).toHaveCount(0);
		const content = JSON.stringify(lastUser(requests[0]!).content);
		expect(content).toContain("asset_id:");
		expect(content).toContain("image omitted: model does not support images");
		expect(content).not.toContain(data);
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("a pasted image queues into an active run and reaches the next model request", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const data = (await readFile(fixture)).toString("base64");
	const requests: Request[] = [];
	const finish = Promise.withResolvers<void>();
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(body));
			if (requests.length === 1) {
				reply(response, "COMPOSER_WORKING", false);
				void finish.promise.then(() => reply(response, " done"));
			} else reply(response, "COMPOSER_FOLLOWUP_IMAGE");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { input: ["text", "image"] });
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByTestId("copilot-chat-textarea").fill("start working");
		await loomPage.getByTestId("copilot-chat-textarea").press("Enter");
		await expect(loomPage.getByText("COMPOSER_WORKING", { exact: true })).toBeVisible();
		await pasteImage(loomPage, data);
		await loomPage.getByTestId("copilot-chat-textarea").press("Enter");
		await expect(loomPage.locator(".session-follow-up")).toBeVisible();
		finish.resolve();
		await expect(loomPage.getByText("COMPOSER_FOLLOWUP_IMAGE", { exact: true })).toBeVisible();
		expect(requests).toHaveLength(2);
		expect(lastUser(requests[1]!).content).toEqual(expect.arrayContaining([{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }]));
	} finally {
		finish.resolve(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
