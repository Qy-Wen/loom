import { expect, test } from "./loom.ts";

test("session tabs can be reordered without switching chats and remember their order per library", async ({ loomPage: page, electronApp, unopenedLibraryRoot }) => {
	test.skip(!electronApp, "isolated Electron required");
	const strip = page.getByRole("tablist", { name: "Sessions" });
	const tabs = strip.getByRole("tab");
	const tab = (name: string) => strip.getByRole("tab", { name, exact: true });
	await expect(tabs).toHaveCount(1);
	const root = await page.evaluate(async () => {
		const { rootPath } = await window.loom.getLibrarySnapshot();
		const [first] = await window.loom.listSessions();
		await window.loom.renameSession(rootPath!, first.id, "First");
		for (const title of ["Second", "Third"]) {
			const session = await window.loom.createSession();
			await window.loom.renameSession(rootPath!, session.id, title);
		}
		return rootPath!;
	});
	await expect(tabs).toHaveText(["Third", "Second", "First"]);
	await tab("Third").click();
	await expect(tab("Third")).toHaveAttribute("aria-selected", "true");

	await tab("First").dragTo(tab("Third"), { targetPosition: { x: 4, y: 12 } });
	await expect(tabs).toHaveText(["First", "Third", "Second"]);
	await expect(tab("Third")).toHaveAttribute("aria-selected", "true");
	await tab("First").press("Alt+Shift+ArrowRight");
	await expect(tabs).toHaveText(["Third", "First", "Second"]);
	await expect(tab("First")).toBeFocused();
	await expect(page.locator(".session-tab-order-status")).toHaveText("First moved to position 2 of 3.");

	const last = tab("Second").locator("..");
	const bounds = (await last.boundingBox())!;
	await tab("Third").dragTo(last, { targetPosition: { x: bounds.width - 4, y: 12 } });
	await expect(tabs).toHaveText(["First", "Second", "Third"]);
	await expect(tab("Third")).toHaveAttribute("aria-selected", "true");

	await page.reload();
	await expect(tabs).toHaveText(["First", "Second", "Third"]);
	await expect(tab("Third")).toHaveAttribute("aria-selected", "true");
	await page.getByRole("button", { name: "New session", exact: true }).click();
	await expect(tabs).toHaveText(["New session", "First", "Second", "Third"]);
	await expect(tab("New session")).toHaveAttribute("aria-selected", "true");

	async function open(path: string) {
		await electronApp!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, path);
		await page.evaluate(() => window.loom.openLibrary());
	}
	await open(unopenedLibraryRoot);
	await expect(tabs).toHaveText(["New session"]);
	await open(root);
	await expect(tabs).toHaveText(["New session", "First", "Second", "Third"]);
	await expect(tab("New session")).toHaveAttribute("aria-selected", "true");
});

test("dragging at the edge of an overflowing session tab strip reaches off-screen tabs", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const strip = page.getByRole("tablist", { name: "Sessions" });
	const tabs = strip.locator("[data-session-tab]");
	await expect(tabs).toHaveCount(1);
	await page.evaluate(async () => {
		for (let i = 0; i < 16; i++) await window.loom.createSession();
	});
	await expect(tabs).toHaveCount(17);
	await expect(tabs.last().getByRole("tab")).toHaveAttribute("aria-selected", "true");
	await strip.evaluate((element) => { element.scrollLeft = 0; });
	const first = tabs.first();
	const startId = await first.getAttribute("data-session-tab");
	const source = (await first.getByRole("tab").boundingBox())!;
	const bounds = (await strip.boundingBox())!;
	const y = source.y + source.height / 2;
	expect(source.x).toBeGreaterThanOrEqual(bounds.x);
	await page.mouse.move(source.x + source.width / 2, y);
	await page.mouse.down();
	try {
		await page.mouse.move(bounds.x + bounds.width - 4, y, { steps: 10 });
		await expect(first).toHaveClass(/dragging/);
		await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
		await page.mouse.move(bounds.x + bounds.width - 30, y, { steps: 2 });
		await expect(strip.locator(".drop-before, .drop-after")).toHaveCount(1);
	} finally {
		await page.mouse.up();
	}
	await expect(first).not.toHaveAttribute("data-session-tab", startId!);
});
