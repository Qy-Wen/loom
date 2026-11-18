import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("links in a Markdown preview open the file, and a missing target is marked as an error", async ({ loomPage, electronApp }) => {
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

		const body = loomPage.locator(".markdown-preview-body");
		await expect(body.locator("a[data-asset-id]")).toHaveCount(3);
		const broken = body.locator("a.markdown-broken-reference");
		await expect(broken).toHaveCount(1);
		await expect(broken).toHaveText("待调研");
		await expect(body.locator("code")).toHaveText("[[产品/说明]]");
		await expect(body.locator("code a")).toHaveCount(0);

		// A missing target is not followed.
		await broken.click();
		await expect(body.getByRole("heading", { name: "说明正文" })).toHaveCount(0);
		await expect(loomPage.getByRole("tablist", { name: "Open files" }).getByRole("tab", { selected: true })).toHaveText("脚本.md");

		// A link to a file opens that file.
		await body.locator("a[data-asset-id]").first().click();
		await expect(body.getByRole("heading", { name: "说明正文" })).toBeVisible();

		// A link with an anchor opens the file scrolled to that heading.
		await tree.locator(".asset-row").filter({ hasText: "脚本.md" }).first().click();
		await body.locator("a[data-anchor][data-asset-id]").filter({ hasText: "结尾" }).click();
		await expect(body.getByRole("heading", { name: "说明正文" })).toBeVisible();
		await expect(body.getByRole("heading", { name: "结尾" })).toBeInViewport();

		// A link to a heading of the same file scrolls within it.
		await tree.locator(".asset-row").filter({ hasText: "脚本.md" }).first().click();
		await expect(body.getByRole("heading", { name: "页脚" })).not.toBeInViewport();
		await body.locator("a[data-anchor]:not([data-asset-id])").click();
		await expect(body.getByRole("heading", { name: "页脚" })).toBeInViewport();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
