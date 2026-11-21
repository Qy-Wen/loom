import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("links in Markdown reading mode open the file and offscreen headings, and a missing target is marked as an error", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(45000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-links-e2e-"));
	await mkdir(join(root, "产品"));
	await writeFile(join(root, "脚本.md"), [
		"[[产品/说明]] 和 [另一篇](产品/说明.md)",
		"",
		"缺失：[[待调研]]",
		"",
		"`[[产品/说明]]`",
		"",
		"[[产品/说明#结尾]]",
		"",
		"[[#页脚]]",
		"",
		...Array.from({ length: 80 }, (_, index) => `填充 ${index}\n`),
		"## 页脚",
	].join("\n"));
	await writeFile(join(root, "产品", "说明.md"), ["# 说明正文", "", ...Array.from({ length: 80 }, (_, index) => `填充 ${index}\n`), "## 结尾"].join("\n"));
	try {
		await electronApp!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, root);
		await loomPage.evaluate(() => window.loom.openLibrary());
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(root);

		const tree = loomPage.locator(".library-sidebar, aside").first();
		await tree.locator(".asset-row").filter({ hasText: "脚本.md" }).first().click();

		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		const body = loomPage.locator(".cm-content");
		await expect(body.locator("[data-asset-id]")).toHaveCount(3);
		const broken = body.locator(".cm-live-broken");
		await expect(broken).toHaveCount(1);
		await expect(broken).toHaveText("待调研");
		await expect(body.locator(".cm-live-code")).toHaveText("[[产品/说明]]");
		await expect(body.locator(".cm-live-code [data-asset-id]")).toHaveCount(0);

		// A missing target is not followed.
		await broken.click();
		await expect(body.getByRole("heading", { name: "说明正文" })).toHaveCount(0);
		await expect(loomPage.getByRole("tablist", { name: "Open files" }).getByRole("tab", { selected: true })).toHaveAccessibleName("脚本.md");

		// A link to a file opens that file.
		await body.locator("[data-asset-id]").first().click();
		await expect(body.getByRole("heading", { name: "说明正文" })).toBeVisible();

		// Ordinary relative Markdown links use the same click-through as wiki links.
		await tree.locator(".asset-row").filter({ hasText: "脚本.md" }).first().click();
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await body.locator("[data-asset-id]").filter({ hasText: "另一篇" }).click();
		await expect(body.getByRole("heading", { name: "说明正文" })).toBeVisible();

		// A link with an anchor opens the file scrolled to that heading.
		await tree.locator(".asset-row").filter({ hasText: "脚本.md" }).first().click();
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await body.locator("[data-anchor][data-asset-id]").filter({ hasText: "结尾" }).click();
		await expect(body).toHaveAttribute("aria-label", "Edit 说明.md");
		await expect(body.getByRole("heading", { name: "结尾" })).toBeInViewport();

		// A link to a heading of the same file scrolls within it.
		await tree.locator(".asset-row").filter({ hasText: "脚本.md" }).first().click();
		await expect(body.getByRole("heading", { name: "页脚" })).not.toBeInViewport();
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await body.locator("[data-anchor]:not([data-asset-id])").click();
		await expect(body.getByRole("heading", { name: "页脚" })).toBeInViewport();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("file history restores Markdown locations, branches and skips removed files", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	const filler = "A paragraph between the linked sections.\n\n".repeat(45);
	await writeFile(join(root, "Source.md"), `# Start\n\n${filler}[[Target#Arrival|Go to target]]\n\n${filler}`);
	const targetPath = join(root, "Target.md");
	await writeFile(targetPath, `# Target\n\n${filler}## Arrival\n\n[[#Farther|Go farther]]\n\n${filler}## Farther\n\n${filler}`);
	await writeFile(join(root, "Branch.md"), "# Branch");
	const rows = page.locator(".library-sidebar .asset-row");
	const back = page.getByRole("button", { name: "Back", exact: true });
	const forward = page.getByRole("button", { name: "Forward", exact: true });
	const editor = (file: string) => page.getByRole("textbox", { name: `Edit ${file}.md`, exact: true });
	const sourceLink = editor("Source").locator(".cm-live-wiki").filter({ hasText: "Go to target" });
	const arrival = editor("Target").locator('[data-heading="arrival"]');
	const farther = editor("Target").locator('[data-heading="farther"]');

	await rows.filter({ hasText: "Source.md" }).click();
	await expect(back).toBeDisabled();
	await expect(forward).toBeDisabled();
	const scroller = page.locator(".cm-scroller");
	await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight / 2 - 100; });
	await sourceLink.scrollIntoViewIfNeeded();
	const originalScroll = await scroller.evaluate((element) => element.scrollTop);
	expect(originalScroll).toBeGreaterThan(100);
	await sourceLink.click();
	await expect(arrival).toBeInViewport();
	await editor("Target").locator("[data-anchor]").filter({ hasText: "Go farther" }).click();
	await expect(farther).toBeInViewport();

	await back.click();
	await expect(arrival).toBeInViewport();
	await expect(farther).not.toBeInViewport();
	await back.click();
	await expect(sourceLink).toBeInViewport();
	await expect.poll(async () => Math.abs(await scroller.evaluate((element) => element.scrollTop) - originalScroll)).toBeLessThan(24);
	await expect(back).toBeDisabled();

	const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
	await editor("Source").press(mac ? "Meta+Alt+ArrowRight" : "Alt+ArrowRight");
	await expect(arrival).toBeInViewport();
	await forward.click();
	await expect(farther).toBeInViewport();
	await expect(forward).toBeDisabled();

	await back.click();
	await rows.filter({ hasText: "Branch.md" }).click();
	await expect(editor("Branch")).toBeVisible();
	await expect(forward).toBeDisabled();
	await rm(targetPath);
	await expect(rows.filter({ hasText: "Target.md" })).toHaveCount(0);
	await back.click();
	await expect(sourceLink).toBeInViewport();
	await forward.click();
	await expect(editor("Branch")).toBeVisible();
});

test("file history follows links in the icon preview", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	await writeFile(join(root, "First.md"), "[[Second|Next file]]");
	await writeFile(join(root, "Second.md"), "# Destination");
	await page.getByRole("button", { name: "Icons", exact: true }).click();
	await page.locator(".browser-tile").filter({ hasText: "First.md" }).dblclick();
	const preview = page.getByRole("dialog", { name: "File preview" });
	const title = preview.locator(".preview-overlay-title");
	await expect(title).toHaveText("First.md");
	await preview.locator("[data-asset-id]").filter({ hasText: "Next file" }).click();
	await expect(title).toHaveText("Second.md");
	await page.getByRole("button", { name: "Back", exact: true }).click();
	await expect(title).toHaveText("First.md");
	await page.getByRole("button", { name: "Forward", exact: true }).click();
	await expect(title).toHaveText("Second.md");
});
