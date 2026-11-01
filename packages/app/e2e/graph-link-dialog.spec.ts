import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("the Add link dialog starts empty and closes on a press outside it, not inside", async ({ loomPage, electronApp }) => {
	await expect(loomPage.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
	const userData = await electronApp!.evaluate(() => process.env.LOOM_E2E_USER_DATA as string);
	const root = (JSON.parse(await readFile(join(userData, "last-library.json"), "utf8")) as { rootPath: string }).rootPath;
	await writeFile(join(root, "a.md"), "a");
	await writeFile(join(root, "b.md"), "b");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(2);
	await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		await window.loom.createRelation(assets[0]!.assetId, assets[1]!.assetId, "ALPHA");
		await window.loom.createRelation(assets[0]!.assetId, assets[1]!.assetId, "BETA");
	});
	await loomPage.reload();
	await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).click();

	const nodes = loomPage.locator(".graph-node");
	await expect(nodes).toHaveCount(2, { timeout: 15_000 });
	const box = async (index: number) => (await nodes.nth(index).locator("circle").first().boundingBox())!;
	const dialog = loomPage.getByRole("dialog", { name: "Create relation" });

	// The layout moves for a moment after the nodes appear; wait until it stops before dragging.
	async function settle(): Promise<void> {
		let last = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			const now = JSON.stringify([await box(0), await box(1)]);
			if (now === last) return;
			last = now;
			await loomPage.waitForTimeout(250);
		}
	}
	// Drag from the first node's rim onto the second node.
	async function openDialog(): Promise<void> {
		await settle();
		const from = await box(0);
		const to = await box(1);
		const fromX = from.x + from.width / 2;
		const fromY = from.y + from.height / 2;
		const toX = to.x + to.width / 2;
		const toY = to.y + to.height / 2;
		await loomPage.mouse.move(fromX + (from.width / 2) * 0.85, fromY, { steps: 3 });
		await loomPage.waitForTimeout(150);
		await loomPage.mouse.down();
		await loomPage.mouse.move((fromX + toX) / 2, (fromY + toY) / 2, { steps: 5 });
		await loomPage.mouse.move(toX, toY, { steps: 5 });
		await expect(loomPage.locator(".graph-node.drop-target circle")).toHaveCount(1);
		await loomPage.mouse.up();
		await expect(dialog).toBeVisible();
	}

	// Hovering a node's rim shows a "+" handle; its mark sits at the centre of its circle.
	await settle();
	const hovered = await box(0);
	await loomPage.mouse.move(hovered.x + hovered.width / 2 + (hovered.width / 2) * 0.85, hovered.y + hovered.height / 2, { steps: 3 });
	await expect(loomPage.locator(".graph-plus")).toHaveCount(1);
	const offset = await loomPage.evaluate(() => {
		const circle = document.querySelector(".graph-plus circle")!.getBoundingClientRect();
		const mark = document.querySelector(".graph-plus-mark")!.getBoundingClientRect();
		return {
			dx: (mark.left + mark.right) / 2 - (circle.left + circle.right) / 2,
			dy: (mark.top + mark.bottom) / 2 - (circle.top + circle.bottom) / 2,
		};
	});
	expect(Math.abs(offset.dx)).toBeLessThan(0.5);
	expect(Math.abs(offset.dy)).toBeLessThan(0.5);

	// While a link is dragged onto a node, only the node's own outline marks it: no extra ring around it.
	await openDialog();
	const input = dialog.getByRole("textbox");
	const toggle = dialog.locator(".suggest-toggle");
	const options = dialog.getByRole("option");
	await expect(input).toHaveValue("");
	await expect(input).toBeFocused();
	await expect(input).toHaveAttribute("aria-expanded", "false");
	await expect(options).toHaveCount(0);
	await input.click();
	await expect(options).toHaveText(["ALPHA", "BETA"]);
	await toggle.click();
	await expect(options).toHaveCount(0);
	await input.click(); // Reopen even though autofocus/toggle kept the input focused.
	await expect(options).toHaveCount(2);
	await input.press("Escape");
	await expect(options).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await input.press("ArrowDown");
	await expect(options).toHaveCount(2);
	await input.fill("BET");
	await expect(options).toHaveText(["BETA"]);
	await options.click();
	await expect(input).toHaveValue("BETA");
	await expect(options).toHaveCount(0);

	// Presses inside the dialog keep it open.
	await input.click();
	await dialog.locator(".graph-type-dialog-title").click();
	await expect(dialog).toBeVisible();

	// A press on empty canvas closes it.
	const canvas = (await loomPage.locator(".graph-view").boundingBox())!;
	await loomPage.mouse.click(canvas.x + 10, canvas.y + canvas.height - 10);
	await expect(dialog).toHaveCount(0);

	// So does a press outside the graph.
	await openDialog();
	await loomPage.getByRole("button", { name: "Help", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await loomPage.keyboard.press("Escape");
});
