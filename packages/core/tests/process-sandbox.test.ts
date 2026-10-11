import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runMediaProcess } from "../src/media/run.ts";
import { prepareSandboxedBash, releaseProcessSandbox, sandboxReadPaths, sandboxedArgv, setProcessSandboxEnabled, setProcessSandboxRoot, shellCommand } from "../src/sandbox/process-sandbox.ts";

describe("process sandbox", { concurrency: false }, () => {
	test("does not spawn when no library is open", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-sandbox-closed-"));
		const previous = process.env.LOOM_FFMPEG_PATH;
		process.env.LOOM_FFMPEG_PATH = join(dir, "ffmpeg");
		try {
			await assert.rejects(
				runMediaProcess({ program: "ffmpeg", args: ["-version"] }),
				/no library is open/,
			);
			await assert.rejects(
				prepareSandboxedBash({ command: "echo hi", cwd: dir, env: {} }),
				/no library is open/,
			);
		} finally {
			if (previous === undefined) delete process.env.LOOM_FFMPEG_PATH;
			else process.env.LOOM_FFMPEG_PATH = previous;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("bash stays inside the library and off the network", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-sandbox-live-"));
		const outside = join(homedir(), ".loom-sandbox-outside-probe");
		const sentinel = "loom-sandbox-sentinel";
		setProcessSandboxRoot(dir);
		const execution = {
			command: [
				`echo ${sentinel}`,
				"printf ok > inside.txt",
				`if printf no > ${quote(outside)}; then echo OUTSIDE_OK; else echo OUTSIDE_BLOCKED; fi`,
				"if curl -sS -o /dev/null --max-time 8 https://example.com; then echo NET_OK; else echo NET_BLOCKED; fi",
			].join("\n"),
			cwd: dir,
			env: {} as Record<string, string>,
		};
		try {
			await prepareSandboxedBash(execution);
			assert.equal(execution.command.includes(sentinel), false);
			assert.match(execution.command, /^exec /);

			const output = await runHostShell(execution.command, dir, execution.env);
			assert.match(output, new RegExp(sentinel));
			assert.match(output, /OUTSIDE_BLOCKED/);
			assert.match(output, /NET_BLOCKED/);
			assert.equal(existsSync(outside), false);
			assert.equal(await readFile(join(dir, "inside.txt"), "utf8"), "ok");
		} finally {
			await releaseProcessSandbox(dir);
			await rm(outside, { force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("windows read grants skip system trees", () => {
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		const library = join(tmpdir(), "loom-sandbox-library");
		const kept = sandboxReadPaths([
			library,
			join(programFiles, "Git", "bin"),
			join(systemRoot, "System32"),
		]);
		if (process.platform === "win32") {
			assert.deepEqual(kept, [library]);
		} else {
			assert.equal(kept.length, 3);
		}
	});

	test("windows sandbox runs ffmpeg-shaped arguments through cmd.exe", { skip: process.platform !== "win32" }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-sandbox-cmd-"));
		const filter = "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease";
		const samples = ["hello world", "100%", "a&b", filter];
		const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
		setProcessSandboxRoot(dir);
		try {
			const wrapped = await sandboxedArgv(shellCommand([process.execPath, "-e", script, ...samples]));
			assert.equal(wrapped.argv.some((arg) => /cmd\.exe/i.test(arg)), true);
			const output = await runArgv(wrapped.argv, wrapped.cwd, wrapped.env);
			assert.deepEqual(JSON.parse(output), samples);
		} finally {
			await releaseProcessSandbox(dir);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a turned-off sandbox runs the command directly", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-sandbox-off-"));
		const binary = join(dir, "ffmpeg");
		await writeFile(binary, "#!/bin/sh\necho plain\n", { mode: 0o755 });
		const previous = process.env.LOOM_FFMPEG_PATH;
		process.env.LOOM_FFMPEG_PATH = binary;
		const execution = { command: "echo hi", cwd: dir, env: {} as Record<string, string> };
		try {
			await setProcessSandboxEnabled(false);
			await prepareSandboxedBash(execution);
			assert.equal(execution.command, "echo hi");
			const ran = await runMediaProcess({ program: "ffmpeg", args: [], cwd: dir });
			assert.match(ran.stdout, /plain/);
		} finally {
			await setProcessSandboxEnabled(true);
			if (previous === undefined) delete process.env.LOOM_FFMPEG_PATH;
			else process.env.LOOM_FFMPEG_PATH = previous;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

function runArgv(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	const [command, ...args] = argv;
	if (!command) return Promise.reject(new Error("missing command"));
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(output);
			else reject(new Error(`command exited ${code ?? "unknown"}: ${output}`));
		});
	});
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runHostShell(command: string, cwd: string, env: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/bash", ["-c", command], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(output);
			else reject(new Error(`host shell exited ${code ?? "unknown"}: ${output}`));
		});
	});
}
