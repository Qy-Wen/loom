import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("a Markdown reference and its reverse manual relation are distinct and independently selectable", async ({ loomPage, electronApp }) => {
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
		await window.loom.createRelation(b.assetId, a.assetId, "ALPHA");
		return (await window.loom.listGraphRelations()).map((edge) => `${edge.type}:${edge.source}`).sort();
	});
	expect(sources).toEqual(["ALPHA:manual", "reference:markdown"]);

	const nodes = loomPage.locator(".graph-node");
	const openFreshGraph = async () => {
		await loomPage.reload();
		await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).click();
		await expect(nodes).toHaveCount(2, { timeout: 15_000 });
	};
	const nodeDistance = () => nodes.evaluateAll(([a, b]) => {
		const position = (element: Element) => (element as SVGGElement).transform.baseVal.getItem(0).matrix;
		const from = position(a!);
		const to = position(b!);
		return Math.hypot(from.e - to.e, from.f - to.f);
	});
	await openFreshGraph();

	const edges = loomPage.locator(".graph-edge-group");
	await expect(edges).toHaveCount(2);
	await expect(loomPage.locator(".graph-edge-group.derived")).toHaveCount(1);
	const reciprocalDistance = await nodeDistance();
	expect(reciprocalDistance).toBeGreaterThan(135);
	for (const id of ["graph-arrow", "graph-arrow-selected"]) {
		const marker = loomPage.locator(`#${id}`);
		await expect(marker).toHaveAttribute("markerUnits", "userSpaceOnUse");
		await expect(marker).toHaveAttribute("markerWidth", "5.5");
		await expect(marker).toHaveAttribute("markerHeight", "5.5");
	}
	const manualPath = loomPage.locator(".graph-edge-group:not(.derived) .graph-edge");
	const shaftFitsInsideArrow = (element: Element) => {
		const markerSelector = element.getAttribute("marker-end")!.slice(4, -1);
		const marker = document.querySelector<SVGMarkerElement>(markerSelector)!;
		const triangle = marker.querySelector("path")!;
		const { strokeWidth, strokeLinecap } = getComputedStyle(element);
		const halfStroke = Number.parseFloat(strokeWidth) / 2;
		const refX = marker.refX.baseVal.value;
		const refY = marker.refY.baseVal.value;
		return strokeLinecap === "butt"
			&& triangle.isPointInFill({ x: refX, y: refY - halfStroke })
			&& triangle.isPointInFill({ x: refX, y: refY + halfStroke });
	};
	expect(await manualPath.evaluate(shaftFitsInsideArrow)).toBe(true);
	const measurePath = (element: Element) => {
		const path = element as SVGPathElement;
		const length = path.getTotalLength();
		const transform = path.getScreenCTM()!;
		const screenPoint = (distance: number) => {
			const { x, y } = path.getPointAtLength(distance).matrixTransform(transform);
			return { x, y };
		};
		return {
			start: screenPoint(0),
			afterStart: screenPoint(1),
			middle: screenPoint(length / 2),
			beforeEnd: screenPoint(length - 1),
			end: screenPoint(length),
		};
	};
	const [derived, manual] = await Promise.all([
		loomPage.locator(".graph-edge-group.derived .graph-edge").evaluate(measurePath),
		manualPath.evaluate(measurePath),
	]);
	const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
	const middleGap = distance(derived.middle, manual.middle);
	for (const gap of [distance(derived.start, manual.end), distance(derived.end, manual.start)]) {
		expect(gap).toBeGreaterThan(2);
		expect(gap).toBeLessThan(middleGap);
	}
	const centers = await nodes.evaluateAll((elements) => Object.fromEntries(elements.map((element) => {
		const { e, f } = (element as SVGGElement).getScreenCTM()!;
		return [element.getAttribute("aria-label"), { x: e, y: f }];
	})));
	for (const [path, sourceName, targetName] of [[derived, "a.md", "b.md"], [manual, "b.md", "a.md"]] as const) {
		const endpoints = [
			{ endpoint: path.start, neighbor: path.afterStart, center: centers[sourceName]! },
			{ endpoint: path.end, neighbor: path.beforeEnd, center: centers[targetName]! },
		];
		for (const { endpoint, neighbor, center } of endpoints) {
			const dot = (endpoint.x - neighbor.x) * (center.x - endpoint.x)
				+ (endpoint.y - neighbor.y) * (center.y - endpoint.y);
			expect(dot / (distance(endpoint, neighbor) * distance(endpoint, center))).toBeGreaterThan(0.999);
		}
	}

	// A derived edge explains where it comes from and offers no removal.
	await loomPage.mouse.click(derived.middle.x, derived.middle.y);
	await expect(loomPage.locator(".graph-caption-note")).toContainText("Markdown");
	await expect(loomPage.locator(".graph-caption").getByRole("button", { name: /^Remove/ })).toHaveCount(0);

	// A manual edge can still be removed.
	await loomPage.mouse.click(manual.middle.x, manual.middle.y);
	await expect(loomPage.locator(".graph-caption-note")).toHaveCount(0);
	await expect(manualPath).toHaveAttribute("marker-end", "url(#graph-arrow-selected)");
	expect(await manualPath.evaluate(shaftFitsInsideArrow)).toBe(true);
	await loomPage.locator(".graph-caption").getByRole("button", { name: "Remove ALPHA" }).click();
	await expect(edges).toHaveCount(1);
	await expect(loomPage.locator(".graph-edge-group.derived")).toHaveCount(1);

	// A fresh layout gives the same spacing with just the original reference.
	await openFreshGraph();
	await expect(edges).toHaveCount(1);
	expect(await nodeDistance()).toBeCloseTo(reciprocalDistance, 1);

	// A wider bundle gives each new edge the same room at the midpoint.
	await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		const a = assets.find((asset) => asset.relativePath === "a.md")!;
		const b = assets.find((asset) => asset.relativePath === "b.md")!;
		for (let index = 0; index < 7; index++) {
			await window.loom.createRelation(a.assetId, b.assetId, `TYPE ${index}`);
		}
	});
	await openFreshGraph();
	await expect(edges).toHaveCount(8);
	const middles = await edges.locator(".graph-edge").evaluateAll((elements) => elements.map((element) => {
		const path = element as SVGPathElement;
		const { x, y } = path.getPointAtLength(path.getTotalLength() / 2);
		return { x, y };
	}));
	for (const middle of middles) {
		const nearest = Math.min(...middles.filter((other) => other !== middle).map((other) => distance(middle, other)));
		expect(nearest).toBeCloseTo(16, 1);
	}
});
