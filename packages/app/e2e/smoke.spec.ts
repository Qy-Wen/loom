import { expect, test } from "./loom.ts";

test("workbench shell is visible", async ({ loomPage }) => {
	await expect(loomPage.getByText("Loom", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(loomPage.getByRole("button", { name: "Agent" })).toBeVisible();
});
