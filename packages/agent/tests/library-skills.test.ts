import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "#vendor/pi-agent";
import { LIBRARY_SKILLS_DIR, loadLibrarySkills, systemPromptWithSkills } from "../src/library-skills.ts";
import { createWorkspaceTools } from "../src/pi-tools.ts";

const BODY = "SECRET_BODY_MUST_STAY_OUT_OF_THE_CATALOG";

async function writeSkill(libraryRoot: string, name: string, description: string, body: string): Promise<void> {
	const dir = join(libraryRoot, LIBRARY_SKILLS_DIR, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

test("loadLibrarySkills skips a missing .agents/skills directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-missing-"));
	try {
		const { skills, diagnostics } = await loadLibrarySkills(
			createWorkspaceTools(root).toolContext.env,
			root,
			BACKGROUND_CONTEXT,
		);
		assert.deepEqual(skills, []);
		assert.deepEqual(diagnostics, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("loadLibrarySkills reads SKILL.md under .agents/skills and leaves other trees alone", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-load-"));
	try {
		await writeSkill(
			root,
			"brand-voice",
			"Apply the house brand voice when writing titles or copy.",
			BODY,
		);
		await mkdir(join(root, "clips"), { recursive: true });
		await writeFile(
			join(root, "clips", "SKILL.md"),
			"---\nname: clips-skill\ndescription: Must not load from the asset tree.\n---\n\nignored\n",
		);
		await mkdir(join(root, "skills", "other"), { recursive: true });
		await writeFile(
			join(root, "skills", "other", "SKILL.md"),
			"---\nname: other\ndescription: Must not load from library skills/.\n---\n\nignored\n",
		);

		const { skills, diagnostics } = await loadLibrarySkills(
			createWorkspaceTools(root).toolContext.env,
			root,
			BACKGROUND_CONTEXT,
		);
		assert.equal(diagnostics.length, 0);
		assert.equal(skills.length, 1);
		assert.equal(skills[0]?.name, "brand-voice");
		assert.match(skills[0]?.description ?? "", /house brand voice/);
		assert.equal(skills[0]?.content.includes(BODY), true);
		assert.match(skills[0]?.filePath.replaceAll("\\", "/") ?? "", /\.agents\/skills\/brand-voice\/SKILL\.md$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("systemPromptWithSkills lists the catalog without skill bodies", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-prompt-"));
	try {
		await writeSkill(
			root,
			"brand-voice",
			"Apply the house brand voice when writing titles or copy.",
			BODY,
		);
		const { skills } = await loadLibrarySkills(
			createWorkspaceTools(root).toolContext.env,
			root,
			BACKGROUND_CONTEXT,
		);
		const prompt = systemPromptWithSkills("You are Loom.", skills);
		assert.match(prompt, /^You are Loom.\n\nThe following skills provide specialized instructions/);
		assert.match(prompt, /<name>brand-voice<\/name>/);
		assert.match(prompt, /<description>Apply the house brand voice when writing titles or copy.<\/description>/);
		assert.match(prompt, /\.agents\/skills\/brand-voice\/SKILL\.md<\/location>/);
		assert.doesNotMatch(prompt, new RegExp(BODY));
		assert.equal(systemPromptWithSkills("You are Loom.", []), "You are Loom.");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
