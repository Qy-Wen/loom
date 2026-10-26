import { expect, test } from "./loom.ts";

test("many open sessions scroll instead of overlapping, and the current one stays in view", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running library");
	const list = () => loomPage.evaluate(() => window.loom.listSessions());
	// The Electron instance is shared with later specs, so remove whatever this one adds.
	const before = new Set((await list()).map((session) => session.id));
	try {
		for (let count = (await list()).filter((session) => session.status === "open").length; count < 24; count++) {
			await loomPage.evaluate(() => window.loom.createSession());
		}
		await loomPage.reload();
		await expect(loomPage.getByRole("tablist", { name: "Sessions" }).getByRole("tab").first()).toBeVisible();

		// No tab's close button reaches into the next tab.
		const overlaps = await loomPage.evaluate(() => {
			const items = [...document.querySelectorAll(".session-tabs .session-tab")].map((el) => ({
				box: el.getBoundingClientRect(),
				close: el.querySelector(".session-tab-close")!.getBoundingClientRect(),
			}));
			return items.filter((item, index) => items[index + 1] && item.close.right > items[index + 1].box.left + 0.5).length;
		});
		expect(overlaps).toBe(0);

		// Selecting a tab that was scrolled off screen keeps it in view even when the strip is narrower than the tabs.
		const strip = loomPage.locator(".session-tabs");
		await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
		await loomPage.locator(".session-tab").nth(3).getByRole("tab").dispatchEvent("click");
		await expect(loomPage.locator(".session-tab.active")).toBeInViewport({ ratio: 0.95 });
		await loomPage.locator(".session-tab").last().getByRole("tab").dispatchEvent("click");
		await expect(loomPage.locator(".session-tab.active")).toBeInViewport({ ratio: 0.95 });
		await loomPage.locator(".session-tab").first().getByRole("tab").dispatchEvent("click");
		await expect(loomPage.locator(".session-tab.active")).toBeInViewport({ ratio: 0.95 });
	} finally {
		for (const session of (await list()).filter((item) => !before.has(item.id))) {
			await loomPage.evaluate((id) => window.loom.deleteSession(id), session.id);
		}
		await loomPage.reload();
	}
});
