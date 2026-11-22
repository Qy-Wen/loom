import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Locator } from "playwright";
import { expect, test } from "./loom.ts";

function inPreview(preview: Locator, script: string): Promise<unknown> {
	return preview.evaluate(async (node, script) => {
		try { return await (node as Electron.WebviewTag).executeJavaScript(script); }
		catch { return null; } // The guest may still be attaching.
	}, script);
}

test("an HTML file opened from the tree can be previewed, edited and saved", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(root).toBeTruthy();
	const file = join((await root())!, "report.html");
	await writeFile(file, '<!doctype html><h1>Original report</h1><style>h1 { color: rgb(20, 60, 100); }</style>');
	await page.locator(".library-sidebar .asset-row").filter({ hasText: "report.html" }).click();

	const toolbar = page.getByRole("toolbar", { name: "HTML view" });
	const favorite = toolbar.getByRole("button", { name: "Add to Favorites" });
	const preview = toolbar.getByRole("button", { name: "Preview mode" });
	const edit = toolbar.getByRole("button", { name: "Edit mode" });
	const guest = page.locator('webview[aria-label="Preview report.html"]');
	await expect(toolbar.getByRole("button")).toHaveCount(2);
	await expect(toolbar.getByRole("button").first()).toHaveAccessibleName("Add to Favorites");
	await expect(edit).toHaveAttribute("aria-pressed", "true");
	await edit.hover();
	await expect(edit).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect.poll(() => inPreview(guest, 'document.querySelector("h1")?.textContent')).toBe("Original report");
	await expect.poll(() => inPreview(guest, 'getComputedStyle(document.querySelector("h1")).color')).toBe("rgb(20, 60, 100)");

	await favorite.click();
	await expect(toolbar.getByRole("button").first()).toHaveAccessibleName("Remove from Favorites");
	await edit.click();
	await expect(guest).toHaveCount(0);
	await expect(preview).toHaveAttribute("aria-pressed", "false");
	const source = page.getByRole("textbox", { name: "Edit report.html" });
	await expect(source).toBeFocused();
	await expect(page.locator(".source-editor .cm-editor.cm-focused")).toHaveCSS("outline-style", "none");
	await expect(source).toContainText("<h1>Original report</h1>");
	const updated = '<!doctype html><h1>Updated report</h1><script>document.querySelector("h1").dataset.scriptRan = "yes";</script>';
	await source.press("ControlOrMeta+a");
	await page.keyboard.insertText(updated);
	await preview.click();
	await expect.poll(() => inPreview(guest, 'document.querySelector("h1[data-script-ran=yes]")?.textContent')).toBe("Updated report");
	await expect.poll(() => readFile(file, "utf8")).toBe(updated);

	await edit.click();
	await expect(source).toContainText("<h1>Updated report</h1>");
	await source.press("ControlOrMeta+z");
	await source.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toContain("<h1>Original report</h1>");
});

test("HTML opens interactively in the workbench with an isolated offline guest", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("Accessible");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const root = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
		await expect.poll(root).toBeTruthy();
		await writeFile(join((await root())!, "drawing.html"), `<!doctype html>
			<canvas width="20" height="20" style="display:block"></canvas>
			<button id="next">Next drawing</button>
			<button id="check">Check isolation</button>
			<output id="status">Static</output>
			<script>
				const output = document.querySelector("#status");
				const canvas = document.querySelector("canvas");
				const ctx = canvas.getContext("2d");
				requestAnimationFrame(() => {
					ctx.fillStyle = "red";
					ctx.fillRect(0, 0, 20, 20);
					output.textContent = "Drawing ready";
				});
				document.querySelector("#next").addEventListener("click", () => {
					ctx.fillStyle = "blue";
					ctx.fillRect(0, 0, 20, 20);
				});
				canvas.addEventListener("pointermove", () => { canvas.dataset.hovered = "yes"; });
				document.querySelector("#check").addEventListener("click", async () => {
					const popup = window.open("about:blank");
					const network = await fetch("${endpoint}").then(() => "online", () => "blocked");
					output.textContent = [typeof window.loom, typeof window.require, !popup, network].join(" ");
				});
			</script>`);
		await page.locator(".library-sidebar .asset-row").filter({ hasText: "drawing.html" }).click();
		const guest = page.locator('webview[aria-label="Preview drawing.html"]');
		await expect(guest).toBeVisible();
		const output = () => inPreview(guest, 'document.querySelector("output")?.textContent');
		await expect.poll(output).toBe("Drawing ready");
		expect(await electronApp!.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);

		const src = await guest.getAttribute("src");
		const guestPage = electronApp!.context().pages().find((page) => page.url() === src);
		await guestPage!.mouse.move(15, 15);
		await expect.poll(() => inPreview(guest, 'document.querySelector("canvas").dataset.hovered')).toBe("yes");
		const pixel = () => inPreview(guest, 'Array.from(document.querySelector("canvas").getContext("2d").getImageData(0, 0, 1, 1).data)');
		expect(await pixel()).toEqual([255, 0, 0, 255]);
		await inPreview(guest, 'document.querySelector("#next").click()');
		expect(await pixel()).toEqual([0, 0, 255, 255]);
		await inPreview(guest, 'document.querySelector("#check").click()');
		await expect.poll(output).toBe("undefined undefined true blocked");

		const contentsId = await guest.evaluate((node) => (node as Electron.WebviewTag).getWebContentsId());
		const navigationBlocked = await electronApp!.evaluate(async ({ webContents }, { contentsId, endpoint }) => {
			const contents = webContents.fromId(contentsId);
			if (!contents) throw new Error("HTML preview is missing");
			const blocked = new Promise<boolean>((resolve) => {
				contents.once("will-frame-navigate", (event) => resolve(event.defaultPrevented));
			});
			await contents.executeJavaScript(`setTimeout(() => location.assign(${JSON.stringify(endpoint)}), 0)`);
			return blocked;
		}, { contentsId, endpoint });
		expect(navigationBlocked).toBe(true);

		await page.getByRole("button", { name: "Edit mode" }).click();
		await expect(guest).toHaveCount(0);
		await expect.poll(() => electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id) === undefined, contentsId)).toBe(true);
		expect(requests).toBe(0);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
