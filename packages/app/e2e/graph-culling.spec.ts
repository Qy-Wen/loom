import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

const STILL = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);

test("graph draws only what is on screen and shrinks far-away nodes to plain dots", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await copyFile(STILL, join(root, "photo.png"));
	for (let index = 0; index < 60; index++) await writeFile(join(root, `note-${String(index).padStart(2, "0")}.md`), "x");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(61);
	await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).click();

	const nodes = loomPage.locator(".graph-node");
	const canvas = loomPage.locator(".graph-canvas");
	await expect(nodes.first()).toBeVisible({ timeout: 15_000 });
	const box = (await canvas.boundingBox())!;
	const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await loomPage.mouse.move(centre.x, centre.y);

	// Everything fits at the opening zoom, so every node exists and carries its name.
	await expect(nodes).toHaveCount(61);
	await expect(loomPage.locator(".graph-node-name")).toHaveCount(61);

	// Zoom out until a node is too small to read: names and previews go, the colored disc stays.
	for (let step = 0; step < 12; step++) {
		await loomPage.keyboard.down("Control");
		await loomPage.mouse.wheel(0, 120);
		await loomPage.keyboard.up("Control");
	}
	await expect(nodes).toHaveCount(61);
	await expect(loomPage.locator(".graph-node-name")).toHaveCount(0);
	await expect(loomPage.locator(".graph-node-preview")).toHaveCount(0);
	await expect(nodes.first().locator(".graph-node-outline")).not.toHaveAttribute("fill", "none");

	// Pan far away: the nodes leave the DOM instead of being drawn off screen.
	for (let step = 0; step < 6; step++) await loomPage.mouse.wheel(4000, 0);
	await expect.poll(() => nodes.count()).toBeLessThan(61);
	expect(await nodes.count()).toBe(0);

	// Panning back brings them back.
	for (let step = 0; step < 6; step++) await loomPage.mouse.wheel(-4000, 0);
	await expect(nodes).toHaveCount(61);
});
