import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("dragging on empty graph canvas box-selects files and the file tree follows", async ({ loomPage, electronApp }) => {
	await expect(loomPage.getByText("Loom", { exact: true })).toBeVisible({ timeout: 30_000 });
	const userData = await electronApp!.evaluate(() => process.env.LOOM_E2E_USER_DATA as string);
	const root = (JSON.parse(await readFile(join(userData, "last-library.json"), "utf8")) as { rootPath: string }).rootPath;
	for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(root, name), name);
	await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).click();

	const nodes = loomPage.locator(".graph-node");
	await expect(nodes).toHaveCount(3, { timeout: 15_000 });
	const canvas = loomPage.locator(".graph-canvas");
	const selectedRows = loomPage.locator(".library-sidebar .asset-row.selected");

	async function centres(): Promise<Array<{ name: string; x: number; y: number }>> {
		const found: Array<{ name: string; x: number; y: number }> = [];
		for (let index = 0; index < 3; index++) {
			const node = nodes.nth(index);
			const rect = (await node.locator("circle").first().boundingBox())!;
			found.push({ name: (await node.locator("title").textContent())!, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
		}
		return found.sort((left, right) => left.name.localeCompare(right.name));
	}
	// The layout moves for a moment after the nodes appear; wait until it stops.
	async function settle(): Promise<void> {
		let last = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			const now = JSON.stringify(await centres());
			if (now === last) return;
			last = now;
			await loomPage.waitForTimeout(250);
		}
	}
	async function dragBox(from: { x: number; y: number }, to: { x: number; y: number }, modifier?: "Shift"): Promise<void> {
		if (modifier) await loomPage.keyboard.down(modifier);
		await loomPage.mouse.move(from.x, from.y);
		await loomPage.mouse.down();
		await loomPage.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
		await loomPage.mouse.move(to.x, to.y, { steps: 4 });
		await loomPage.mouse.up();
		if (modifier) await loomPage.keyboard.up(modifier);
	}

	await settle();
	const [a, b, c] = await centres();
	const area = (await canvas.boundingBox())!;
	const left = { x: area.x + 8, y: area.y + 8 };
	const bottom = area.y + area.height - 8;
	const pad = 40;

	// The box is drawn while dragging, and a plain drag does not pan the canvas.
	const worldBefore = await canvas.locator(".graph-world > g").first().getAttribute("transform");
	await loomPage.mouse.move(left.x, left.y);
	await loomPage.mouse.down();
	await loomPage.mouse.move(left.x + 60, left.y + 60, { steps: 4 });
	await expect(loomPage.locator(".graph-box")).toHaveCount(1);
	await loomPage.mouse.up();
	await expect(loomPage.locator(".graph-box")).toHaveCount(0);
	expect(await canvas.locator(".graph-world > g").first().getAttribute("transform")).toBe(worldBefore);

	// A box around two nodes selects exactly those two, in the graph and in the file tree.
	const around = (first: typeof a, second: typeof a) => ({
		from: { x: Math.min(first.x, second.x) - pad, y: Math.min(first.y, second.y) - pad },
		to: { x: Math.max(first.x, second.x) + pad, y: Math.max(first.y, second.y) + pad },
	});
	const ab = around(a, b);
	await dragBox(ab.from, ab.to);
	await expect(selectedRows).toHaveCount(2);
	await expect(loomPage.locator(".library-sidebar .asset-row.selected", { hasText: "a.md" })).toHaveCount(1);
	await expect(loomPage.locator(".library-sidebar .asset-row.selected", { hasText: "b.md" })).toHaveCount(1);
	await expect(loomPage.locator(".graph-node.selected")).toHaveCount(2);

	// Boxing another one replaces the selection.
	const cc = around(c, c);
	await dragBox(cc.from, cc.to);
	await expect(selectedRows).toHaveCount(1);
	await expect(selectedRows.first()).toContainText("c.md");

	// With Shift it adds.
	await dragBox(ab.from, ab.to, "Shift");
	await expect(selectedRows).toHaveCount(3);

	// A click on empty canvas clears; a click on a node selects that one only.
	await loomPage.mouse.click(left.x, bottom);
	await expect(selectedRows).toHaveCount(0);
	await expect(loomPage.locator(".graph-node.selected")).toHaveCount(0);
	await dragBox(ab.from, ab.to);
	await expect(selectedRows).toHaveCount(2);
	await loomPage.mouse.click(c.x, c.y);
	await expect(selectedRows).toHaveCount(1);
	await expect(selectedRows.first()).toContainText("c.md");

	// A box over empty canvas clears when replacing and keeps the selection with Shift.
	await dragBox({ x: left.x, y: bottom - 30 }, { x: left.x + 30, y: bottom });
	await expect(selectedRows).toHaveCount(0);
	await dragBox(ab.from, ab.to);
	await dragBox({ x: left.x, y: bottom - 30 }, { x: left.x + 30, y: bottom }, "Shift");
	await expect(selectedRows).toHaveCount(2);

	// The scroll wheel pans.
	const before = await canvas.locator(".graph-world > g").first().getAttribute("transform");
	await loomPage.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
	await loomPage.mouse.wheel(40, 30);
	await expect.poll(() => canvas.locator(".graph-world > g").first().getAttribute("transform")).not.toBe(before);
});
