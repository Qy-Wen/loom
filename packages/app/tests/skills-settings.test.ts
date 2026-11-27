import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIBRARY_SKILLS_DIR, SKILLS_STATE_FILE } from "@loom/agent/durable";
import { SkillsService } from "../src/main/skills/skills-service.ts";

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-service-"));
	const userDir = join(root, "user-skills");
	let libraryRoot: string | null = join(root, "library");
	await mkdir(libraryRoot, { recursive: true });
	const trashed: string[] = [];
	const opened: string[] = [];
	const revealed: string[] = [];
	const service = new SkillsService({
		userSkillsDir: userDir,
		getLibraryRoot: () => libraryRoot,
		trashItem: async (target) => {
			trashed.push(target);
			await rm(target, { recursive: true, force: true });
		},
		openPath: async (target) => {
			opened.push(target);
			return "";
		},
		showItemInFolder: (target) => {
			revealed.push(target);
		},
	});
	return {
		root,
		userDir,
		getLibraryRoot: () => libraryRoot,
		setLibraryRoot: (next: string | null) => { libraryRoot = next; },
		trashed,
		opened,
		revealed,
		service,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

test("SkillsService creates, reads, saves losslessly, and lists across user and library scopes", async () => {
	const fixture = await createFixture();
	try {
		const created = await fixture.service.create({
			scope: "user",
			name: "brand-voice",
			description: "Keep copy concise and clear.",
			content: "Use short sentences.",
		});
		assert.equal(created.scope, "user");
		assert.equal(created.id, "brand-voice/SKILL.md");
		assert.equal(created.enabled, true);
		assert.equal(created.disableModelInvocation, false);
		assert.equal(created.content, "Use short sentences.");

		// Add custom frontmatter key, disable-model-invocation, and a supporting file on disk.
		const raw = await readFile(created.filePath, "utf8");
		await writeFile(created.filePath, raw.replace("description:", "author: loom-team\ndisable-model-invocation: true\ndescription:"));
		await mkdir(join(created.baseDir, "references"), { recursive: true });
		await writeFile(join(created.baseDir, "references", "guide.md"), "# Guide\n");

		const saved = await fixture.service.save({
			scope: "user",
			id: created.id,
			description: "Updated description.",
			content: "Use active voice.",
		});
		assert.equal(saved.description, "Updated description.");
		assert.equal(saved.disableModelInvocation, true);
		assert.equal(saved.content, "Use active voice.");
		assert.deepEqual(saved.supportingFiles, ["references/guide.md"]);
		assert.equal(saved.supportingFileCount, 1);
		assert.match(await readFile(created.filePath, "utf8"), /author: loom-team/);

		// Create same-name library skill to verify override flags.
		await fixture.service.create({
			scope: "library",
			name: "brand-voice",
			description: "Library override.",
			content: "Library rules.",
		});
		const view = await fixture.service.list();
		assert.equal(view.user.find((s) => s.name === "brand-voice")?.overriddenByLibrary, true);
		assert.equal(view.library.find((s) => s.name === "brand-voice")?.overridesUser, true);

		// Disabling library skill removes override and restores user skill precedence.
		const afterDisable = await fixture.service.setEnabled("library", "brand-voice", false);
		assert.equal(afterDisable.library.find((s) => s.name === "brand-voice")?.enabled, false);
		assert.equal(afterDisable.library.find((s) => s.name === "brand-voice")?.overridesUser, false);
		assert.equal(afterDisable.user.find((s) => s.name === "brand-voice")?.overriddenByLibrary, false);

		// Reject reserved, invalid, and duplicate names.
		await assert.rejects(() => fixture.service.create({ scope: "user", name: "compact", description: "x", content: "" }), /reserved/i);
		await assert.rejects(() => fixture.service.create({ scope: "user", name: "Bad_Name", description: "x", content: "" }), /lowercase/i);
		await assert.rejects(() => fixture.service.create({ scope: "user", name: "brand-voice", description: "x", content: "" }), /already exists/i);

		// Without an open library, user skills still list cleanly.
		fixture.setLibraryRoot(null);
		const noLib = await fixture.service.list();
		assert.equal(noLib.libraryDir, null);
		assert.equal(noLib.library.length, 0);
		assert.equal(noLib.user.length, 1);
	} finally {
		await fixture.cleanup();
	}
});

test("SkillsService deletes directory and flat-file skills safely and cleans up disabled state", async () => {
	const fixture = await createFixture();
	try {
		await fixture.service.create({
			scope: "user",
			name: "dir-skill",
			description: "Directory skill.",
			content: "Body",
		});
		await fixture.service.setEnabled("user", "dir-skill", false);

		// Add a flat .md skill directly in userDir.
		const flatFile = join(fixture.userDir, "quick-note.md");
		await writeFile(flatFile, "---\nname: quick-note\ndescription: Flat skill.\n---\n\nFlat body\n");

		const before = await fixture.service.list();
		assert.equal(before.user.length, 2);
		const flat = before.user.find((s) => s.name === "quick-note")!;
		assert.equal(flat.kind, "file");
		assert.equal(flat.id, "quick-note.md");

		// Deleting flat file removes only that file, NOT userDir!
		const afterFlat = await fixture.service.delete("user", flat.id);
		assert.equal(afterFlat.user.length, 1);
		assert.equal(fixture.trashed.at(-1)?.endsWith("quick-note.md"), true);

		// Deleting directory skill removes its folder and clears disabled state.
		const afterDir = await fixture.service.delete("user", "dir-skill/SKILL.md");
		assert.equal(afterDir.user.length, 0);
		const stateRaw = JSON.parse(await readFile(join(fixture.userDir, SKILLS_STATE_FILE), "utf8"));
		assert.deepEqual(stateRaw.disabled, []);
	} finally {
		await fixture.cleanup();
	}
});

test("SkillsService reports diagnostics and enforces path containment on openFolder", async () => {
	const fixture = await createFixture();
	try {
		const created = await fixture.service.create({
			scope: "user",
			name: "color-grade",
			description: "Grade footage.",
			content: "Apply LUT.",
		});
		const libSkillsDir = join(fixture.getLibraryRoot()!, ...LIBRARY_SKILLS_DIR.split("/"));
		await mkdir(join(libSkillsDir, "broken"), { recursive: true });
		await writeFile(join(libSkillsDir, "broken", "SKILL.md"), "---\nname: [broken\n---\n");

		const view = await fixture.service.list();
		assert.ok(view.diagnostics.some((d) => d.scope === "library" && d.path.includes("broken")));

		await fixture.service.openFolder("user");
		assert.equal(fixture.opened.length, 1);
		await fixture.service.openFolder("user", created.filePath);
		assert.equal(fixture.revealed.length, 1);
		await assert.rejects(() => fixture.service.openFolder("user", fixture.root), /outside/i);
	} finally {
		await fixture.cleanup();
	}
});
