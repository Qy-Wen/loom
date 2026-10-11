import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { SandboxManager, VENDORED_SRT_WIN_EXE, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { tryResolveMediaBinaries } from "../media/binaries.ts";

/**
 * Process sandbox for bash and bundled ffmpeg/ffprobe.
 * The open library and the temp directory are writable. The user profile is not
 * readable. Network is off. No library, or a failed wrap, does not spawn.
 * Read, edit, and write stay in-process. MCP and generation jobs are not wrapped.
 * Windows must name the packaged srt-win.exe; the runtime does not pick it up.
 * On Windows the inner shell is cmd.exe. Program Files and Windows are already
 * readable, so they are not granted another ACE. The bash tool still uses Git Bash.
 */

const WINDOWS_PROXY_PORT_RANGE: [number, number] = [20080, 20089];

const HELPER_SOURCE = `
"use strict";
const { spawn } = require("node:child_process");
const { readFileSync, rmSync } = require("node:fs");
const specPath = process.env.LOOM_SANDBOX_SPEC;
if (!specPath) {
  console.error("LOOM_SANDBOX_SPEC is missing");
  process.exit(1);
}
let raw;
try {
  raw = readFileSync(specPath, "utf8");
  rmSync(specPath, { force: true });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const spec = JSON.parse(raw);
const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  env: spec.env,
  stdio: "inherit",
  windowsHide: true,
});
const stop = () => {
  child.kill();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code === null || code === undefined ? 1 : code);
});
`;

let root: string | undefined;
let applied: string | undefined;
let enabled = true;
let chain: Promise<void> = Promise.resolve();
let helperReady: Promise<string> | undefined;

export function setProcessSandboxRoot(next: string): void {
	root = resolve(next);
}

export function processSandboxEnabled(): boolean {
	return enabled;
}

/** The next bash or ffmpeg uses this. Turning it off drops a running sandbox proxy. */
export async function setProcessSandboxEnabled(next: boolean): Promise<void> {
	enabled = next;
	if (next) return;
	await enqueue(async () => {
		if (enabled || applied === undefined) return;
		await SandboxManager.reset();
		applied = undefined;
	});
}

/** Drop the sandbox when this library is still the open one. */
export async function releaseProcessSandbox(expected: string): Promise<void> {
	const wanted = resolve(expected);
	await enqueue(async () => {
		if (root !== wanted) return;
		root = undefined;
		if (applied === undefined) return;
		await SandboxManager.reset();
		applied = undefined;
	});
}

export async function sandboxedArgv(
	command: string,
	cwd?: string,
	shell?: string,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv; cwd: string }> {
	const library = await ensureSandbox();
	const spawnCwd = cwd ?? library;
	try {
		const wrapped = await SandboxManager.wrapWithSandboxArgv(command, shell ?? innerShell(), undefined, undefined, spawnCwd);
		const commandPath = wrapped.argv[0];
		if (!commandPath) throw new Error("Sandbox refused to start: the sandbox returned no command.");
		return { argv: wrapped.argv, env: wrapped.env, cwd: spawnCwd };
	} catch (error) {
		throw refused(error);
	}
}

/**
 * Replace a bash command with a fixed host command. The user command is only in
 * a temp spec the helper deletes. Vendor pi always spawns `shell -c`, which
 * cannot take the Windows sandbox argv.
 */
export async function prepareSandboxedBash(execution: {
	command: string;
	cwd: string;
	env: Record<string, string>;
}): Promise<void> {
	if (!enabled) return;
	if (root === undefined) throw new Error("Sandbox refused to start: no library is open.");
	const wrapped = await sandboxedArgv(execution.command, execution.cwd, bashShell());
	const helper = await spawnHelperPath();
	const specPath = join(tmpdir(), `loom-sandbox-${randomBytes(16).toString("hex")}.json`);
	const env = stringEnv(wrapped.env);
	delete env.LOOM_SANDBOX_SPEC;
	await writeFile(specPath, JSON.stringify({ argv: wrapped.argv, env, cwd: wrapped.cwd }), { mode: 0o600 });
	execution.command = `exec ${quotePosix(process.execPath)} ${quotePosix(helper)}`;
	execution.env = {
		...execution.env,
		LOOM_SANDBOX_SPEC: specPath,
		ELECTRON_RUN_AS_NODE: "1",
	};
}

/** One command for the sandbox shell. POSIX on macOS and Linux, cmd.exe on Windows. */
export function shellCommand(args: string[]): string {
	if (process.platform === "win32") return quoteCmd(args);
	return posixCommand(args);
}

/** One POSIX command. Each argument is single-quoted so the host does not parse it. */
export function posixCommand(args: string[]): string {
	return args.map(quotePosix).join(" ");
}

/** srt-win already wraps this string for cmd /s, so it is parsed as a normal command line. */
function quoteCmd(args: string[]): string {
	return args.map(quoteCmdArg).join(" ");
}

function quoteCmdArg(value: string): string {
	if (value.length === 0) return '""';
	if (!/[\s"%&|<>^()!\r\n]/.test(value)) return value;
	// A bare % is left alone on the command line, but %name% still expands inside quotes.
	// Close the quote, emit a caret-escaped %, then reopen it.
	return `"${value.replaceAll('"', '""').replaceAll("%", '"^%"')}"`;
}

function quotePosix(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function ensureSandbox(): Promise<string> {
	for (;;) {
		const wanted = root;
		if (!wanted) throw new Error("Sandbox refused to start: no library is open.");
		await enqueue(() => apply(wanted));
		if (root === wanted && applied === wanted) return wanted;
	}
}

async function apply(wanted: string): Promise<void> {
	if (!enabled || root !== wanted || applied === wanted) return;
	const shell = innerShell();
	if (!SandboxManager.isSupportedPlatform()) {
		throw new Error("Sandbox refused to start: this operating system is not supported.");
	}
	if (applied !== undefined) {
		await SandboxManager.reset();
		applied = undefined;
	}
	if (root !== wanted) return;
	try {
		await SandboxManager.initialize(runtimeConfig(wanted, shell));
	} catch (error) {
		throw refused(error);
	}
	if (root !== wanted) {
		await SandboxManager.reset();
		applied = undefined;
		return;
	}
	applied = wanted;
}

function runtimeConfig(libraryRoot: string, shell: string): SandboxRuntimeConfig {
	const library = canonical(libraryRoot);
	const temp = canonical(tmpdir());
	const readable = sandboxReadPaths([library, temp, ...shellReadPaths(shell), ...binaryDirs()]);
	const config: SandboxRuntimeConfig = {
		network: {
			allowedDomains: [],
			deniedDomains: [],
		},
		filesystem: {
			denyRead: profileDenyRoots(),
			allowRead: readable,
			allowWrite: uniquePaths([library, temp]),
			denyWrite: [],
		},
	};
	if (process.platform === "win32") {
		config.windows = {
			srtWin: { path: VENDORED_SRT_WIN_EXE },
			// The package default 60080–60089 often sits inside a Windows excluded
			// port range, so the proxy cannot bind. 20080–20089 stays clear of
			// that band. Keep this in sync with scripts/ensure-windows-sandbox.mjs.
			proxyPortRange: WINDOWS_PROXY_PORT_RANGE,
		};
	}
	return config;
}

function profileDenyRoots(): string[] {
	// Windows runs the child as a separate account. That account already has no
	// access to the user profile. Stamping C:\Users fails, and stamping the
	// profile itself walks every file under it.
	if (process.platform === "win32") return [];
	if (process.platform === "linux") return ["/home"];
	return ["/Users"];
}

function binaryDirs(): string[] {
	const binaries = tryResolveMediaBinaries();
	if (!binaries) return [];
	return [dirname(binaries.ffmpeg), dirname(binaries.ffprobe)];
}

function shellReadPaths(shell: string): string[] {
	if (process.platform !== "win32") return [dirname(shell)];
	const bash = windowsBash();
	return bash ? [dirname(bash)] : [];
}

/** Paths that need a read ACE. Windows system trees are already readable by Users. */
export function sandboxReadPaths(paths: string[]): string[] {
	const unique = uniquePaths(paths);
	if (process.platform !== "win32") return unique;
	return unique.filter((path) => !windowsAlreadyReadable(path));
}

function windowsAlreadyReadable(path: string): boolean {
	const resolved = canonical(path).replaceAll("/", "\\").toLowerCase();
	return machineReadableRoots().some((root) => {
		const base = canonical(root).replaceAll("/", "\\").toLowerCase();
		return resolved === base || resolved.startsWith(`${base}\\`);
	});
}

function machineReadableRoots(): string[] {
	const names = [
		"ProgramFiles",
		"ProgramFiles(x86)",
		"ProgramW6432",
		"CommonProgramFiles",
		"CommonProgramFiles(x86)",
		"SystemRoot",
		"windir",
	];
	const roots: string[] = [];
	for (const name of names) {
		const value = process.env[name];
		if (value) roots.push(value);
	}
	return roots;
}

function innerShell(): string {
	if (process.platform === "win32") return windowsCmd();
	if (existsSync("/bin/bash")) return "/bin/bash";
	if (existsSync("/bin/sh")) return "/bin/sh";
	throw new Error("Sandbox refused to start: bash was not found.");
}

function bashShell(): string {
	if (process.platform !== "win32") return innerShell();
	const found = windowsBash();
	if (!found) {
		throw new Error(
			"Sandbox refused to start: Git Bash was not found. The bash tool needs it. Install Git for Windows and try again.",
		);
	}
	return found;
}

function windowsCmd(): string {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	const path = join(root, "System32", "cmd.exe");
	if (!existsSync(path)) throw new Error("Sandbox refused to start: cmd.exe was not found.");
	return path;
}

function windowsBash(): string | undefined {
	const candidates: string[] = [];
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	if (programFiles) candidates.push(join(programFiles, "Git", "bin", "bash.exe"));
	if (programFilesX86) candidates.push(join(programFilesX86, "Git", "bin", "bash.exe"));
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		if (!entry) continue;
		candidates.push(join(entry, "bash.exe"));
	}
	return candidates.find((candidate) => existsSync(candidate));
}

function spawnHelperPath(): Promise<string> {
	if (!helperReady) {
		const path = join(tmpdir(), "loom-sandbox-spawn.cjs");
		helperReady = writeFile(path, HELPER_SOURCE, { mode: 0o700 }).then(
			() => path,
			(error: unknown) => {
				helperReady = undefined;
				throw error;
			},
		);
	}
	return helperReady;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const copy: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") copy[key] = value;
	}
	return copy;
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.map(canonical))];
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function refused(error: unknown): Error {
	if (error instanceof Error && error.message.startsWith("Sandbox refused to start:")) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`Sandbox refused to start: ${message}`);
}

function enqueue(operation: () => Promise<void>): Promise<void> {
	const run = chain.then(operation, operation);
	chain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
