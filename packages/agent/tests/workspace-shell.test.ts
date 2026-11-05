import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceTools } from "../src/tools/pi-tools.ts";

test("Windows registers PowerShell without Bash, preferring Git Bash when installed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "loom-shell-choice-"));
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const previous = { ProgramFiles: process.env.ProgramFiles, "ProgramFiles(x86)": process.env["ProgramFiles(x86)"], PATH: process.env.PATH };
	try {
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		process.env.ProgramFiles = dir;
		delete process.env["ProgramFiles(x86)"];
		process.env.PATH = "";
		const names = async () => (await createWorkspaceTools({ images: false })).map((tool) => tool.name);
		assert.deepEqual(await names(), ["read", "powershell", "edit", "write"]);
		await mkdir(join(dir, "System32"));
		await writeFile(join(dir, "System32", "bash.exe"), "");
		process.env.PATH = join(dir, "System32");
		assert.deepEqual(await names(), ["read", "powershell", "edit", "write"]);
		await mkdir(join(dir, "Git", "bin"), { recursive: true });
		await writeFile(join(dir, "Git", "bin", "bash.exe"), "");
		assert.deepEqual(await names(), ["read", "bash", "edit", "write"]);
		Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
		assert.deepEqual(await names(), ["read", "bash", "edit", "write"]);
	} finally {
		Object.defineProperty(process, "platform", platform);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
