import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, NodeExecutionEnv, createLibraryExtension, LibraryRuntime, createModels } from "../src/durable.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { LIBRARY_SKILLS_DIR, loadLibrarySkills, formatSkillsForSystemPrompt } from "../src/extensions/library-skills.ts";

const BODY = "SECRET_BODY_MUST_STAY_OUT_OF_THE_CATALOG";

async function writeSkill(libraryRoot: string, name: string, description: string, body: string): Promise<void> {
	const dir = join(libraryRoot, LIBRARY_SKILLS_DIR, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

test("loadLibrarySkills skips a missing .loom/agents/skills directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-missing-"));
	try {
		const { skills, diagnostics } = await loadLibrarySkills(new NodeExecutionEnv({ cwd: root }), root, BACKGROUND_CONTEXT);
		assert.deepEqual(skills, []);
		assert.deepEqual(diagnostics, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("loadLibrarySkills reads SKILL.md under .loom/agents/skills and leaves other trees alone", async () => {
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

		const { skills, diagnostics } = await loadLibrarySkills(new NodeExecutionEnv({ cwd: root }), root, BACKGROUND_CONTEXT);
		assert.equal(diagnostics.length, 0);
		assert.equal(skills.length, 1);
		assert.equal(skills[0]?.name, "brand-voice");
		assert.match(skills[0]?.description ?? "", /house brand voice/);
		assert.equal(skills[0]?.content.includes(BODY), true);
		assert.match(skills[0]?.filePath.replaceAll("\\", "/") ?? "", /\.loom\/agents\/skills\/brand-voice\/SKILL\.md$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("formatSkillsForSystemPrompt lists the catalog without skill bodies", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-prompt-"));
	try {
		await writeSkill(
			root,
			"brand-voice",
			"Apply the house brand voice when writing titles or copy.",
			BODY,
		);
		const { skills } = await loadLibrarySkills(new NodeExecutionEnv({ cwd: root }), root, BACKGROUND_CONTEXT);
		const prompt = formatSkillsForSystemPrompt(skills);
		assert.match(prompt, /^The following skills provide specialized instructions/);
		assert.match(prompt, /<name>brand-voice<\/name>/);
		assert.match(prompt, /<description>Apply the house brand voice when writing titles or copy.<\/description>/);
		assert.match(prompt.replaceAll("\\", "/"), /\.loom\/agents\/skills\/brand-voice\/SKILL\.md<\/location>/);
		assert.doesNotMatch(prompt, new RegExp(BODY));
		assert.equal(formatSkillsForSystemPrompt([]), "");
		assert.equal(formatSkillsForSystemPrompt(skills.map((skill) => ({ ...skill, disableModelInvocation: true }))), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("skills honor scoped ignores, stop at a skill root, diagnose malformed/duplicate metadata and skip symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-rules-"));
	try {
		await writeSkill(root, "valid", "A & B < C", BODY);
		await writeSkill(root, "ignored", "ignored", BODY);
		await writeSkill(root, "valid/nested", "nested", BODY);
		await writeSkill(root, "duplicate", "duplicate", BODY);
		await writeFile(join(root, LIBRARY_SKILLS_DIR, "duplicate", "SKILL.md"), "---\nname: valid\ndescription: duplicate\n---\nbody");
		await writeSkill(root, "bad", "bad", BODY);
		await writeFile(join(root, LIBRARY_SKILLS_DIR, "bad", "SKILL.md"), "---\nname: [broken\n---\nbody");
		await writeFile(join(root, LIBRARY_SKILLS_DIR, ".ignore"), "ignored/\n");
		await symlink(root, join(root, LIBRARY_SKILLS_DIR, "cycle"), process.platform === "win32" ? "junction" : "dir");
		const result = await loadLibrarySkills(new NodeExecutionEnv({ cwd: root }), root, BACKGROUND_CONTEXT);
		assert.equal(result.skills.length, 1);
		assert.ok(result.diagnostics.some((row) => /Duplicate skill/.test(row.message)));
		assert.ok(result.diagnostics.some((row) => row.path.endsWith("bad/SKILL.md") || row.path.endsWith("bad\\SKILL.md")));
		assert.ok(!result.skills.some((row) => row.name === "nested" || row.name === "ignored"));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("library skills section reloads the catalog on a later request without injecting bodies", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-skills-section-"));
	let owner: LibraryRuntime | undefined;
	try {
		await writeSkill(root, "brand-voice", "A & B < C", BODY);
		const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
		const assembly = await createLibraryExtension(root, { autoMemory: false, workspace: { images: false } });
		owner = await LibraryRuntime.open(root, { models, extensions: [assembly.extension], agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, BACKGROUND_CONTEXT);
		const conversation = await owner.createConversation({}, BACKGROUND_CONTEXT);
		for (const description of ["A &amp; B &lt; C", "New description"]) {
			faux.setResponses([(request) => {
				const system = request.messages.findLast((message) => message.role === "system");
				assert.ok(JSON.stringify(system).includes(description), JSON.stringify(request));
				assert.doesNotMatch(JSON.stringify(request), new RegExp(BODY));
				return fauxAssistantMessage("done");
			}]);
			const result = await (await conversation.submit({ type: "input", content: "hello" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
			assert.equal(result.status, "done", JSON.stringify(result));
			await writeSkill(root, "brand-voice", "New description", BODY);
		}
	} finally { await owner?.close(BACKGROUND_CONTEXT); await rm(root, { recursive: true, force: true }); }
});
