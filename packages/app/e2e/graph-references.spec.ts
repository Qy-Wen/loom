import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("references from a Markdown file are read-only next to a manual relation", async ({ loomPage, electronApp }) => {
	await expect(loomPage.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
	const userData = await electronApp!.evaluate(() => process.env.LOOM_E2E_USER_DATA as string);
	const root = (JSON.parse(await readFile(join(userData, "last-library.json"), "utf8")) as { rootPath: string }).rootPath;
	await writeFile(join(root, "a.md"), "See [[b]].");
	await writeFile(join(root, "b.md"), "b");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listGraphRelations())).length, { timeout: 20_000 }).toBe(1);

	const sources = await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		const a = assets.find((asset) => asset.relativePath === "a.md")!;
		const b = assets.find((asset) => asset.relativePath === "b.md")!;
		await window.loom.createRelation(a.assetId, b.assetId, "ALPHA");
		return (await window.loom.listGraphRelations()).map((edge) => `${edge.type}:${edge.source}`).sort();
	});
	expect(sources).toEqual(["ALPHA:manual", "reference:markdown"]);

	await loomPage.reload();
	await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).click();
	await expect(loomPage.locator(".graph-node")).toHaveCount(2, { timeout: 15_000 });

	const edges = loomPage.locator(".graph-edge-group");
	await expect(edges).toHaveCount(2);
	await expect(loomPage.locator(".graph-edge-group.derived")).toHaveCount(1);

	// A derived edge explains where it comes from and offers no removal.
	await loomPage.locator(".graph-edge-group.derived .graph-edge-hit").dispatchEvent("pointerdown");
	await expect(loomPage.locator(".graph-caption-note")).toContainText("Markdown");
	await expect(loomPage.locator(".graph-caption").getByRole("button", { name: /^Remove/ })).toHaveCount(0);

	// A manual edge can still be removed.
	await loomPage.locator(".graph-edge-group:not(.derived) .graph-edge-hit").dispatchEvent("pointerdown");
	await expect(loomPage.locator(".graph-caption-note")).toHaveCount(0);
	await loomPage.locator(".graph-caption").getByRole("button", { name: "Remove ALPHA" }).click();
	await expect(edges).toHaveCount(1);
	await expect(loomPage.locator(".graph-edge-group.derived")).toHaveCount(1);
});
