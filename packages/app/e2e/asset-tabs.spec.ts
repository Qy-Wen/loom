import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("asset tabs follow browser rules and close with their file", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(45000);
	const previousRoot = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const root = await mkdtemp(join(tmpdir(), "loom-tabs-e2e-"));
	const fixture = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);
	await mkdir(join(root, "one")); await mkdir(join(root, "two"));
	await copyFile(fixture, join(root, "alpha.png"));
	await copyFile(fixture, join(root, "beta.png"));
	await copyFile(fixture, join(root, "one", "same.png"));
	await copyFile(fixture, join(root, "two", "same.png"));
	await writeFile(join(root, "notes.md"), "# hello\n");
	async function open(path: string) {
		await electronApp!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, path);
		await loomPage.evaluate(() => window.loom.openLibrary());
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(path);
	}
	const strip = loomPage.getByRole("tablist", { name: "Open files" });
	const tree = loomPage.locator(".library-sidebar, aside").first();
	const file = (name: string) => tree.locator(".asset-row").filter({ hasText: name }).first();
	// A real mouse drag: the welcome page only takes a drop that started from a tree row.
	async function dragToWorkbench(name: string) {
		const from = (await file(name).boundingBox())!;
		const to = (await loomPage.locator(".workbench").boundingBox())!;
		await loomPage.mouse.move(from.x + 20, from.y + from.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
		await expect(loomPage.locator(".welcome.drop-ready")).toBeVisible();
		await loomPage.mouse.up();
	}
	try {
		await open(root);
		await expect(strip).toHaveCount(0);

		await file("alpha.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");

		// A plain click replaces the active tab.
		await file("beta.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("beta.png");

		// Right-click moves the tree focus but must not change the shown tab.
		await file("alpha.png").click({ button: "right" });
		await loomPage.keyboard.press("Escape");
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("beta.png");

		// Middle-click opens a new tab next to it.
		await file("alpha.png").click({ button: "middle" });
		await expect(strip.getByRole("tab")).toHaveText(["beta.png", "alpha.png"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");

		// A file that is already open is shown, not duplicated.
		await file("beta.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(2);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("beta.png");

		// Clicking a tab selects it in the tree.
		await strip.getByRole("tab", { name: "alpha.png" }).click();
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");
		await expect(file("alpha.png")).toHaveClass(/selected/);

		// Two open files with the same name show their folder.
		const same = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.filter((asset) => asset.filename === "same.png");
		expect(same).toHaveLength(2);
		for (const folder of ["one", "two"]) await tree.locator(".folder-main").filter({ hasText: folder }).first().click();
		await tree.locator(".asset-row").filter({ hasText: "same.png" }).nth(0).click({ button: "middle" });
		await tree.locator(".asset-row").filter({ hasText: "same.png" }).nth(1).click({ button: "middle" });
		await expect(strip.getByRole("tab", { name: "same.png · one" })).toHaveCount(1);
		await expect(strip.getByRole("tab", { name: "same.png · two" })).toHaveCount(1);
		await expect(strip.getByRole("tab")).toHaveCount(4);

		await file("notes.md").click({ button: "middle" });
		await expect(strip.getByRole("tab")).toHaveCount(5);

		// Dragging a tab reorders it; the active tab stays active.
		const names = () => strip.getByRole("tab");
		await expect(names()).toHaveText(["beta.png", "alpha.png", "same.png · one", "same.png · two", "notes.md"]);
		const box = async (name: string) => (await strip.getByRole("tab", { name }).boundingBox())!;
		const last = await box("notes.md");
		await strip.getByRole("tab", { name: "beta.png" }).dragTo(strip.getByRole("tab", { name: "notes.md" }), {
			targetPosition: { x: last.width - 4, y: last.height / 2 },
		});
		await expect(names()).toHaveText(["alpha.png", "same.png · one", "same.png · two", "notes.md", "beta.png"]);
		const first = await box("alpha.png");
		await strip.getByRole("tab", { name: "notes.md" }).dragTo(strip.getByRole("tab", { name: "alpha.png" }), {
			targetPosition: { x: 4, y: first.height / 2 },
		});
		await expect(names()).toHaveText(["notes.md", "alpha.png", "same.png · one", "same.png · two", "beta.png"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("notes.md");
		// A tab dropped on the file tree is not a file move.
		await strip.getByRole("tab", { name: "notes.md" }).dragTo(tree.locator(".folder-main").filter({ hasText: "one" }).first());
		await expect(names()).toHaveCount(5);
		expect((await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.find((asset) => asset.filename === "notes.md")!.relativePath).toBe("notes.md");
		// Put the tabs back in the order the rest of the test expects.
		await strip.getByRole("tab", { name: "notes.md" }).dragTo(strip.getByRole("tab", { name: "beta.png" }), {
			targetPosition: { x: (await box("beta.png")).width - 4, y: 10 },
		});
		await expect(names()).toHaveText(["alpha.png", "same.png · one", "same.png · two", "beta.png", "notes.md"]);

		// Closing the active tab shows a neighbour.
		await strip.getByRole("button", { name: "Close notes.md" }).click();
		await expect(strip.getByRole("tab")).toHaveCount(4);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("beta.png");

		// Middle-click on a tab closes it.
		await strip.getByRole("tab", { name: "beta.png" }).click({ button: "middle" });
		await expect(strip.getByRole("tab")).toHaveCount(3);
		for (let i = 0; i < 2; i++) await strip.getByRole("button", { name: "Close same.png" }).first().click();
		await expect(strip.getByRole("tab")).toHaveText(["alpha.png"]);

		// Dragging files from the tree onto the strip opens them as tabs.
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await file("beta.png").click();
		await expect(strip.getByRole("tab")).toHaveText(["beta.png"]);
		await file("notes.md").dragTo(strip.getByRole("tab", { name: "beta.png" }), { targetPosition: { x: 4, y: 10 } });
		await expect(strip.getByRole("tab")).toHaveText(["notes.md", "beta.png"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("notes.md");
		await expect(file("notes.md")).toHaveClass(/selected/);
		// A file that is already open moves instead of duplicating.
		const endBox = (await strip.getByRole("tab", { name: "beta.png" }).boundingBox())!;
		await file("notes.md").dragTo(strip.getByRole("tab", { name: "beta.png" }), { targetPosition: { x: endBox.width - 4, y: 10 } });
		await expect(strip.getByRole("tab")).toHaveText(["beta.png", "notes.md"]);
		// A folder has no view, so the strip does not take it.
		await tree.locator(".folder-main").filter({ hasText: "one" }).first().dragTo(strip.getByRole("tab", { name: "beta.png" }));
		await expect(strip.getByRole("tab")).toHaveCount(2);
		// With no tab open, dropping on the workbench opens the file.
		for (const name of ["beta.png", "notes.md"]) await strip.getByRole("button", { name: `Close ${name}` }).click();
		await expect(strip).toHaveCount(0);
		await dragToWorkbench("alpha.png");
		await expect(strip.getByRole("tab")).toHaveText(["alpha.png"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");
		await expect(loomPage.locator(".welcome")).toHaveCount(0);

		// Several selected files all open as tabs, in tree order, and the first is shown.
		// Ctrl/Cmd-clicking builds the selection and shows the file it ends on, so the one open tab is now notes.md.
		await file("beta.png").click({ modifiers: [modifier] });
		await file("notes.md").click({ modifiers: [modifier] });
		for (const name of ["alpha.png", "beta.png", "notes.md"]) await expect(file(name)).toHaveClass(/selected/);
		await expect(strip.getByRole("tab")).toHaveText(["notes.md"]);
		await file("beta.png").dragTo(strip.getByRole("tab", { name: "notes.md" }), { targetPosition: { x: 4, y: 10 } });
		await expect(strip.getByRole("tab")).toHaveText(["alpha.png", "beta.png", "notes.md"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");

		// Removing a file externally closes its tab through the library watcher.
		await rm(join(root, "alpha.png"));
		await expect(strip.getByRole("tab")).toHaveText(["beta.png", "notes.md"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveText("beta.png");

		// Switching library forgets every tab.
		await file("beta.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(2);
		await open(previousRoot);
		await expect(strip).toHaveCount(0);
	} finally {
		await open(previousRoot).catch(() => undefined);
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});
