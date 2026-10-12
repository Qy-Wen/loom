import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { processSandboxEnabled, sandboxedArgv, shellCommand } from "../sandbox/process-sandbox.ts";
import type { MediaProgram } from "./binaries.ts";
import { resolveMediaBinary } from "./binaries.ts";

export interface RunMediaProcessOptions {
	program: MediaProgram;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface RunMediaProcessResult {
	stdout: string;
	stderr: string;
}

/**
 * Single process entry for bundled ffmpeg/ffprobe. A turned-on sandbox wraps the
 * child. Callers do not change.
 */
export function runMediaProcess(options: RunMediaProcessOptions): Promise<RunMediaProcessResult> {
	const signal = options.signal;
	if (signal?.aborted) return Promise.reject(abortError(options.program));
	if (!processSandboxEnabled()) return runDirect(options);
	return runSandboxed(options);
}

function runDirect(options: RunMediaProcessOptions): Promise<RunMediaProcessResult> {
	const binary = resolveMediaBinary(options.program);
	const timeoutMs = options.timeoutMs ?? (options.program === "ffprobe" ? 20_000 : 10 * 60_000);
	const child = spawnProgram(binary, options.args, { cwd: options.cwd });
	return watchChild(child, options, timeoutMs);
}

async function runSandboxed(options: RunMediaProcessOptions): Promise<RunMediaProcessResult> {
	const signal = options.signal;
	const binary = resolveMediaBinary(options.program);
	const timeoutMs = options.timeoutMs ?? (options.program === "ffprobe" ? 20_000 : 10 * 60_000);
	let wrapped: Awaited<ReturnType<typeof sandboxedArgv>>;
	try {
		wrapped = await sandboxedArgv(shellCommand([binary, ...options.args]), options.cwd);
	} catch (error) {
		if (signal?.aborted) throw abortError(options.program);
		throw error;
	}
	if (signal?.aborted) throw abortError(options.program);
	const [command, ...args] = wrapped.argv;
	if (!command) throw new Error("Sandbox refused to start: the sandbox returned no command.");

	const child = spawn(command, args, {
		cwd: wrapped.cwd,
		env: wrapped.env,
		shell: false,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return watchChild(child, options, timeoutMs);
}

function watchChild(
	child: ChildProcess,
	options: RunMediaProcessOptions,
	timeoutMs: number,
): Promise<RunMediaProcessResult> {
	const signal = options.signal;
	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (!stdoutStream || !stderrStream) {
		stopChild(child);
		return Promise.reject(new Error(`${options.program} produced no output pipes`));
	}
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const onAbort = () => {
			stopChild(child);
		};

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) reject(abortError(options.program));
			else if (error) reject(error);
			else resolve({ stdout, stderr });
		};

		const timer = setTimeout(() => {
			stopChild(child);
			finish(new Error(`${options.program} timed out`));
		}, timeoutMs);

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		stdoutStream.setEncoding("utf8");
		stderrStream.setEncoding("utf8");
		stdoutStream.on("data", (chunk: string) => {
			stdout += chunk;
		});
		stderrStream.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(formatProcessError(options.program, code, stderr)));
		});
	});
}

function spawnProgram(
	binary: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean },
): ChildProcess {
	// Node refuses to CreateProcess a .cmd/.bat (EINVAL). cmd.exe can run them.
	if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)) {
		const root = process.env.SystemRoot ?? "C:\\Windows";
		const comspec = process.env.ComSpec ?? join(root, "System32", "cmd.exe");
		return spawn(comspec, ["/d", "/s", "/c", cmdLine([binary, ...args])], {
			cwd: options.cwd,
			env: options.env,
			detached: options.detached,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	}
	return spawn(binary, args, {
		cwd: options.cwd,
		env: options.env,
		detached: options.detached,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}

function cmdLine(args: string[]): string {
	return args.map(quoteCmdArg).join(" ");
}

function quoteCmdArg(value: string): string {
	if (value.length === 0) return '""';
	if (!/[\s"%&|<>^()!]/.test(value)) return value;
	return `"${value.replaceAll('"', '""')}"`;
}

function stopChild(child: ChildProcess): void {
	const pid = child.pid;
	if (process.platform === "win32") {
		if (pid) killWindowsTree(pid);
		else child.kill();
		return;
	}
	if (pid) {
		try {
			process.kill(-pid, "SIGTERM");
			return;
		} catch {
			// Already exited, or not a process-group leader.
		}
	}
	child.kill();
}

function killWindowsTree(pid: number): void {
	const root = process.env.SystemRoot ?? "C:\\Windows";
	const killer = spawn(join(root, "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
		stdio: "ignore",
		windowsHide: true,
	});
	killer.once("error", () => {});
}

function abortError(program: MediaProgram): Error {
	const error = new Error(`${program} aborted`);
	error.name = "AbortError";
	return error;
}

function formatProcessError(program: MediaProgram, code: number | null, stderr: string): string {
	const last = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
	return last ? `${program} failed: ${last}` : `${program} exited with code ${code ?? "unknown"}`;
}
