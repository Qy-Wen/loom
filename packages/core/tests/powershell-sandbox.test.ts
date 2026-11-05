import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { prepareSandboxedPowerShell, releaseProcessSandbox, setProcessSandboxEnabled, setProcessSandboxRoot } from "../src/sandbox/process-sandbox.ts";

test("PowerShell sandbox encodes the original script and runs a fixed host helper", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "loom-ps-sandbox-"));
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const previous = process.env.SystemRoot;
	const command = "Write-Output '中文 & %PATH%'; $x = \"a'b\"; exit 7";
	let wrappedCommand = "";
	try {
		await mkdir(join(dir, "System32"));
		await writeFile(join(dir, "System32", "cmd.exe"), "");
		process.env.SystemRoot = dir;
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		t.mock.method(SandboxManager, "isSupportedPlatform", () => true);
		t.mock.method(SandboxManager, "initialize", async () => {});
		t.mock.method(SandboxManager, "reset", async () => {});
		t.mock.method(SandboxManager, "wrapWithSandboxArgv", async (script: string) => {
			wrappedCommand = script;
			return { argv: ["sandbox-test", script], env: {} };
		});
		setProcessSandboxRoot(dir);
		await setProcessSandboxEnabled(true);
		const execution = { command, cwd: dir, env: {} as Record<string, string> };
		await prepareSandboxedPowerShell(execution);
		assert.match(wrappedCommand, /powershell\.exe.*-EncodedCommand/);
		const encoded = wrappedCommand.split("-EncodedCommand ")[1]!;
		assert.ok(Buffer.from(encoded, "base64").toString("utf16le").endsWith(command));
		assert.ok(!execution.command.includes(command));
		assert.match(execution.command, /^& .*; exit \$LASTEXITCODE$/);
		assert.equal(execution.env.ELECTRON_RUN_AS_NODE, "1");
		const spec = JSON.parse(await readFile(execution.env.LOOM_SANDBOX_SPEC!, "utf8"));
		assert.deepEqual(spec.argv, ["sandbox-test", wrappedCommand]);
		assert.equal(spec.cwd, dir);
		assert.equal(spec.env.LOOM_SANDBOX_SPEC, undefined);
		await rm(execution.env.LOOM_SANDBOX_SPEC!);
		await setProcessSandboxEnabled(false);
		const direct = { command, cwd: dir, env: {} };
		await prepareSandboxedPowerShell(direct);
		assert.equal(direct.command, command);
	} finally {
		await releaseProcessSandbox(dir);
		await setProcessSandboxEnabled(true);
		t.mock.restoreAll();
		Object.defineProperty(process, "platform", platform);
		if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
