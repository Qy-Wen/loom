import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, saveChatEndpoint, test } from "./loom.ts";

for (const mode of ["List", "Icons"] as const) {
	test(`${mode.toLowerCase()} mode drags folders into chat, persists and edits references, and opens reply links without switching mode`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(90_000);
		const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
		const block = "<folder_ref>\npath: 资料/nested\n</folder_ref>";
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				requests.push(JSON.parse(body));
				const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "folders", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(chunk({ content: `FOLDER_REPLY_${requests.length}\n${block}` }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
			await saveChatEndpoint(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
			await page.getByRole("button", { name: "New session", exact: true }).click();
			const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
			await mkdir(join(root, "资料", "nested"), { recursive: true });
			await writeFile(join(root, "资料", "nested", "private-note.md"), "FOLDER_CONTENT_SHOULD_NOT_BE_ATTACHED");
			await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(2);
			const sidebar = page.locator(".library-sidebar");
			const display = sidebar.getByRole("group", { name: "File display", exact: true });
			await display.getByRole("button", { name: mode, exact: true }).click();
			const row = (name: string) => sidebar.locator(".folder-row").filter({ hasText: new RegExp(`^${name}$`) });
			const input = page.getByTestId("copilot-chat-textarea");
			const browser = page.locator(".folder-browser");
			const source = mode === "List" ? row("nested").locator(".folder-main") : browser.locator('[data-key="folder:资料/nested"]');
			if (mode === "Icons") {
				await sidebar.locator(".folder-main").filter({ hasText: /^资料$/ }).click();
				await expect(browser.locator(".browser-crumb.current")).toHaveText("资料");
			}
			await input.fill("整理这个文件夹：");
			await source.dragTo(input);
			await expect(input.locator('[data-folder-path="资料/nested"]')).toHaveCount(1);
			await expect(input.locator("[data-asset-id]")).toHaveCount(0);
			await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toEqual(["资料", "资料/nested"]);
			await input.press("Enter");
			await expect(page.getByText(/FOLDER_REPLY_1/).first()).toBeVisible();
			const sent = JSON.stringify(requests[0]!.messages.findLast((message) => message.role === "user")!.content);
			expect(sent).toContain("<folder_ref>");
			expect(sent).toContain("资料/nested");
			expect(sent).not.toContain("private-note.md");
			expect(sent).not.toContain("FOLDER_CONTENT_SHOULD_NOT_BE_ATTACHED");
			await expect(page.locator(".session-user-bubble .session-asset-chip")).toHaveCount(1);
			await expect(page.locator(".folder-ref")).toHaveText("资料/nested");
			await page.reload();
			await expect(page.locator(".folder-ref")).toBeVisible();
			// Both a user chip and an assistant link reveal and unfold the folder in the current mode.
			for (const link of [page.locator(".session-user-bubble .asset-ref"), page.locator(".folder-ref")]) {
				const collapse = row("资料").getByRole("button", { name: "Collapse folder" });
				if (await collapse.count()) await collapse.click();
				await link.click();
				await expect(row("nested")).toBeVisible();
				await expect(row("nested")).toHaveClass(/selected/);
				await expect(display.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
				if (mode === "Icons") await expect(browser.locator(".browser-crumb.current")).toHaveText("nested");
			}
			let bubble = page.getByTestId("copilot-user-message").first();
			await bubble.hover();
			await bubble.getByRole("button", { name: "Edit", exact: true }).click();
			await expect(page.locator('.session-inline-edit [data-folder-path="资料/nested"]')).toHaveCount(1);
			await page.locator(".session-inline-edit-send").click();
			await expect(page.getByText(/FOLDER_REPLY_2/).first()).toBeVisible();
			expect(JSON.stringify(requests[1]!.messages.findLast((message) => message.role === "user")!.content)).toContain("<folder_ref>");
			bubble = page.getByTestId("copilot-user-message").first();
			await bubble.hover();
			await bubble.getByRole("button", { name: "Edit", exact: true }).click();
			await page.locator(".session-inline-edit").getByRole("button", { name: "Remove nested", exact: true }).click();
			await page.locator(".session-inline-edit-send").click();
			await expect(page.getByText(/FOLDER_REPLY_3/).first()).toBeVisible();
			expect(JSON.stringify(requests[2]!.messages.findLast((message) => message.role === "user")!.content)).not.toContain("<folder_ref>");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
}
