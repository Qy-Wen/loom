import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureTempDir, ensureTempRootSync } from "../temp.ts";
import {
	SandboxManager,
	VENDORED_SRT_WIN_EXE,
	getWindowsSandboxUserStatusAsync,
	installWindowsSandboxAsync,
	resolveSrtWin,
	verifyWindowsWfpEgress,
	type SandboxRuntimeConfig,
	type SrtWinSpawn,
} from "@anthropic-ai/sandbox-runtime";
import { tryResolveMediaBinaries } from "../media/binaries.ts";
import { unpackAsarPath } from "../packaged-path.ts";

/**
 * Process sandbox for bash and bundled ffmpeg/ffprobe.
 * The open library and the temp directory are writable. The user profile is not
 * readable. Network is off. No library prevents spawning. On Windows, failed
 * sandbox initialization disables the setting and lets the command run directly.
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
let fallbackPending: Promise<void> | undefined;
let sandboxFailureHandler: ((error: Error) => void | Promise<void>) | undefined;

export function setProcessSandboxFailureHandler(handler: ((error: Error) => void | Promise<void>) | undefined): void {
	sandboxFailureHandler = handler;
}

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

/** Returns undefined if Windows sandbox initialization failed and was disabled. */
export async function sandboxedArgv(
	command: string,
	cwd?: string,
	shell?: string,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv; cwd: string } | undefined> {
	const library = await ensureSandbox();
	if (library === undefined) return undefined;
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
	while (fallbackPending) await fallbackPending;
	if (!enabled) return;
	if (root === undefined) throw new Error("Sandbox refused to start: no library is open.");
	const wrapped = await sandboxedArgv(execution.command, execution.cwd, bashShell());
	if (wrapped === undefined) return;
	const helper = await spawnHelperPath();
	const specPath = join(await ensureTempDir("sandbox"), `${randomBytes(16).toString("hex")}.json`);
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

async function ensureSandbox(): Promise<string | undefined> {
	for (;;) {
		if (fallbackPending) { await fallbackPending; continue; }
		if (!enabled) return undefined;
		const wanted = root;
		if (!wanted) throw new Error("Sandbox refused to start: no library is open.");
		await enqueue(() => apply(wanted));
		if (fallbackPending) continue;
		if (!enabled) return undefined;
		if (root === wanted && applied === wanted) return wanted;
	}
}

async function apply(wanted: string): Promise<void> {
	if (!enabled || root !== wanted || applied === wanted) return;
	try {
		const shell = innerShell();
		if (!SandboxManager.isSupportedPlatform()) {
			throw new Error("Sandbox refused to start: this operating system is not supported.");
		}
		if (applied !== undefined) {
			await SandboxManager.reset();
			applied = undefined;
		}
		if (root !== wanted) return;
		const started = Date.now();
		for (;;) {
			try {
				await SandboxManager.initialize(runtimeConfig(wanted, shell));
				break;
			} catch (error) {
				// Parallel tests each bind two ports in the 10-port Windows range.
				if (!isPortBusy(error) || Date.now() - started > 45_000) throw error;
				await SandboxManager.reset().catch(() => undefined);
				await new Promise((resolve) => setTimeout(resolve, 400));
				if (!enabled || root !== wanted) return;
			}
		}
		if (root !== wanted) {
			await SandboxManager.reset();
			applied = undefined;
			return;
		}
		applied = wanted;
	} catch (cause) {
		const error = refused(cause);
		if (process.platform !== "win32") throw error;
		await disableWindowsSandbox(error);
	}
}

// Re-running the installer rotates the sandbox password and always shows UAC,
// so an existing install is left alone. Keep the checks in sync with
// scripts/ensure-windows-sandbox.mjs. Tests replace these methods.
export const windowsSandboxSetup = {
	resolve(path: string): SrtWinSpawn {
		return resolveSrtWin({ path });
	},
	async ready(srtWin: SrtWinSpawn): Promise<boolean> {
		const user = await getWindowsSandboxUserStatusAsync({ srtWin });
		if (!user.provisioned || !user.credPresent) return false;
		try {
			await verifyWindowsWfpEgress({ srtWin });
			return true;
		} catch {
			return false;
		}
	},
	install(srtWin: SrtWinSpawn) {
		return installWindowsSandboxAsync({ srtWin, proxyPortRange: WINDOWS_PROXY_PORT_RANGE });
	},
};

/**
 * One-time Windows sandbox install for a packaged app. No-ops unless the
 * platform is Windows and the sandbox setting is on. Returns a note when
 * the install was already present or just completed. Cancelling the
 * administrator prompt, or a failed install, turns the sandbox off and
 * reports the reason through the failure handler.
 */
export async function ensureWindowsSandboxInstalled(): Promise<string | undefined> {
	if (process.platform !== "win32") return;
	if (fallbackPending) await fallbackPending;
	if (!enabled) return;
	try {
		const srtWin = windowsSandboxSetup.resolve(unpackAsarPath(VENDORED_SRT_WIN_EXE));
		if (await windowsSandboxSetup.ready(srtWin)) return "Windows sandbox already installed.";
		const result = await windowsSandboxSetup.install(srtWin);
		if (!result.cancelled) return "Windows sandbox installed.";
		await disableWindowsSandbox(new Error("The administrator prompt was cancelled."));
	} catch (cause) {
		await disableWindowsSandbox(cause instanceof Error ? cause : new Error(String(cause)));
	}
	return undefined;
}

async function disableWindowsSandbox(error: Error): Promise<void> {
	// Hold every direct-execution entry until cleanup and failure reporting
	// settle, including callers arriving now.
	let finishFallback!: () => void;
	fallbackPending = new Promise<void>((resolve) => { finishFallback = resolve; });
	enabled = false;
	try {
		let resetError: unknown;
		try {
			await SandboxManager.reset();
		} catch (resetCause) {
			resetError = resetCause;
		} finally {
			applied = undefined;
		}
		const reason = resetError === undefined
			? error
			: new Error(`${error.message} Cleanup also failed: ${resetError instanceof Error ? resetError.message : String(resetError)}`);
		try {
			await sandboxFailureHandler?.(reason);
		} catch (handlerError) {
			console.error("Could not persist Windows sandbox fallback:", handlerError);
		}
		if (!sandboxFailureHandler) console.warn("Windows sandbox disabled after initialization failure:", reason);
	} finally {
		fallbackPending = undefined;
		finishFallback();
	}
}

function runtimeConfig(libraryRoot: string, shell: string): SandboxRuntimeConfig {
	const library = canonical(libraryRoot);
	// Scope is unchanged: the whole OS temp dir stays writable. Only make sure Loom's own subdirectory exists.
	ensureTempRootSync();
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
			srtWin: { path: unpackAsarPath(VENDORED_SRT_WIN_EXE) },
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
		helperReady = (async () => {
			const path = join(await ensureTempDir("sandbox"), "spawn.cjs");
			await writeFile(path, HELPER_SOURCE, { mode: 0o700 });
			return path;
		})().catch((error: unknown) => {
			helperReady = undefined;
			throw error;
		});
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

function isPortBusy(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") return true;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("EADDRINUSE") || message.includes("No free port in range");
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
