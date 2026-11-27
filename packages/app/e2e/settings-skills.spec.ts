import { expect, test } from "./loom.ts";

test("Skills tab creates, edits, overrides, disables, filters, and deletes skills", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = loomPage.locator(".settings-dialog");
	await settings.getByRole("tab", { name: "Skills", exact: true }).click();
	const panel = settings.getByRole("tabpanel", { name: "Skills", exact: true });

	await expect(panel.getByRole("button", { name: "Import", exact: true })).toHaveCount(0);

	// Create a global skill (manual-only toggle is not shown in create mode).
	await panel.getByRole("button", { name: "New skill", exact: true }).click();
	await expect(panel.getByRole("switch", { name: "Manual /skill invocation only", exact: true })).toHaveCount(0);
	await panel.getByRole("textbox", { name: "Name", exact: true }).fill("brand-voice");
	await panel.getByRole("textbox", { name: "Description" }).fill("Apply concise house tone.");
	await panel.getByRole("textbox", { name: "Instructions (Markdown)", exact: true }).fill("Keep sentences short.");
	await panel.getByRole("button", { name: "Create skill", exact: true }).click();

	const globalSection = panel.getByRole("region", { name: "Global", exact: true });
	const librarySection = panel.getByRole("region", { name: "Current library", exact: true });
	await expect(globalSection.getByText("/brand-voice", { exact: true })).toBeVisible();
	await expect(globalSection.getByRole("button", { name: "Reveal in folder", exact: true })).toHaveCount(0);
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listLibrarySkills())).map((s) => s.name)).toContain("brand-voice");

	// Edit description and body (manual-only toggle is not shown in edit mode either).
	await globalSection.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(panel.getByRole("switch")).toHaveCount(0);
	await panel.getByRole("textbox", { name: "Description" }).fill("Updated global tone.");
	await panel.getByRole("button", { name: "Save skill", exact: true }).click();
	await expect(globalSection.getByText("Updated global tone.", { exact: true })).toBeVisible();

	// Create a library skill with the same name -> override badges appear on both.
	await panel.getByRole("button", { name: "New skill", exact: true }).click();
	await panel.getByRole("radio", { name: "Current library", exact: true }).locator("..").click();
	await panel.getByRole("textbox", { name: "Name", exact: true }).fill("brand-voice");
	await panel.getByRole("textbox", { name: "Description" }).fill("Library-specific tone.");
	await panel.getByRole("button", { name: "Create skill", exact: true }).click();
	await expect(librarySection.getByText("Overrides global", { exact: true })).toBeVisible();
	await expect(globalSection.getByText("Overridden by library", { exact: true })).toBeVisible();

	// Disable library skill -> global skill is no longer overridden.
	const librarySwitch = librarySection.getByRole("switch", { name: "Enable skill brand-voice", exact: true });
	await librarySwitch.locator("..").click();
	await expect(librarySwitch).not.toBeChecked();
	await expect(globalSection.getByText("Overridden by library", { exact: true })).toHaveCount(0);

	// Disable global skill too -> removed from runtime / slash menu list.
	const globalSwitch = globalSection.getByRole("switch", { name: "Enable skill brand-voice", exact: true });
	await globalSwitch.locator("..").click();
	await expect(globalSwitch).not.toBeChecked();
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listLibrarySkills())).some((s) => s.name === "brand-voice")).toBe(false);

	// Create a second library skill to test search filter and delete confirmation.
	await panel.getByRole("button", { name: "New skill", exact: true }).click();
	await panel.getByRole("radio", { name: "Current library", exact: true }).locator("..").click();
	await panel.getByRole("textbox", { name: "Name", exact: true }).fill("cut-clips");
	await panel.getByRole("textbox", { name: "Description" }).fill("Trim clips quickly.");
	await panel.getByRole("button", { name: "Create skill", exact: true }).click();
	await expect(librarySection.getByText("/cut-clips", { exact: true })).toBeVisible();

	const search = panel.getByRole("searchbox", { name: "Filter skills", exact: true });
	await search.fill("cut-clips");
	await expect(librarySection.getByText("/cut-clips", { exact: true })).toBeVisible();
	await expect(librarySection.getByText("/brand-voice", { exact: true })).toHaveCount(0);
	await search.fill("");

	const cutRow = librarySection.locator(".skills-item").filter({ hasText: "/cut-clips" });
	await cutRow.getByRole("button", { name: "Delete", exact: true }).click();
	const confirmDialog = loomPage.getByRole("dialog", { name: "Move “cut-clips” to Trash?", exact: true });
	await confirmDialog.getByRole("button", { name: "Move to Trash", exact: true }).click();
	await expect(librarySection.getByText("/cut-clips", { exact: true })).toHaveCount(0);

	await settings.getByRole("button", { name: "Close settings", exact: true }).click();
});
