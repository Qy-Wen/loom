import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { sandboxedArgv, shellCommand } from "../sandbox/process-sandbox.ts";
import type { MediaProgram } from "./binaries.ts";
import { resolveMediaBinary } from "./binaries.ts";

export interface RunMediaProcessOptions {
	program: MediaProgram;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Binary stdin, used for in-memory preview frames. */
	input?: Uint8Array;
	maxOutputBytes?: number;
}

export interface RunMediaProcessResult {
	stdout: string;
	stderr: string;
}

export interface RunMediaProcessBufferResult {
	stdout: Buffer;
	stderr: string;
}

export class MediaOutputLimitError extends Error {
	constructor() {
		super("Media process output exceeds its memory limit");
		this.name = "MediaOutputLimitError";
	}
}

/**
 * Single process entry for bundled ffmpeg/ffprobe. A turned-on sandbox wraps the
 * child. Callers do not change.
 */
export async function runMediaProcess(options: RunMediaProcessOptions): Promise<RunMediaProcessResult> {
	const result = await runMediaProcessBuffer(options);
	return { stdout: result.stdout.toString("utf8"), stderr: result.stderr };
}

export function runMediaProcessBuffer(options: RunMediaProcessOptions): Promise<RunMediaProcessBufferResult> {
	const signal = options.signal;
	if (signal?.aborted) return Promise.reject(abortError(options.program));
	// sandboxedArgv also gates direct execution while fallback is settling.
	return runSandboxed(options.program === "ffmpeg" ? { ...options, args: keepFatalLogs(options.args) } : options);
}

/** Fatal diagnostics are required because some FFmpeg failures still exit 0. */
function keepFatalLogs(args: string[]): string[] {
	const prepared = [...args];
	for (let i = 0; i < prepared.length - 1; i++) {
		if (prepared[i] !== "-v" && prepared[i] !== "-loglevel") continue;
		const level = prepared[++i];
		const match = level.match(/(?:^|[+-])(quiet|panic|-?\d+)$/);
		if (match && (match[1] === "quiet" || match[1] === "panic" || Number(match[1]) < 8)) {
			prepared[i] = `${level.slice(0, -match[1].length)}fatal`;
		}
	}
	return prepared;
}

function runDirect(options: RunMediaProcessOptions): Promise<RunMediaProcessBufferResult> {
	const binary = resolveMediaBinary(options.program);
	const timeoutMs = options.timeoutMs ?? (options.program === "ffprobe" ? 20_000 : 10 * 60_000);
	const child = spawnProgram(binary, options.args, { cwd: options.cwd, input: options.input !== undefined });
	return watchChild(child, options, timeoutMs);
}

async function runSandboxed(options: RunMediaProcessOptions): Promise<RunMediaProcessBufferResult> {
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
	if (wrapped === undefined) return runDirect(options);
	const [command, ...args] = wrapped.argv;
	if (!command) throw new Error("Sandbox refused to start: the sandbox returned no command.");

	const child = spawn(command, args, {
		cwd: wrapped.cwd,
		env: wrapped.env,
		shell: false,
		detached: process.platform !== "win32",
		stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	return watchChild(child, options, timeoutMs);
}

function watchChild(
	child: ChildProcess,
	options: RunMediaProcessOptions,
	timeoutMs: number,
): Promise<RunMediaProcessBufferResult> {
	const signal = options.signal;
	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (!stdoutStream || !stderrStream) {
		stopChild(child);
		return Promise.reject(new Error(`${options.program} produced no output pipes`));
	}
	return new Promise((resolve, reject) => {
		const stdout: Buffer[] = [];
		let outputBytes = 0;
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
			else resolve({ stdout: Buffer.concat(stdout, outputBytes), stderr });
		};

		const timer = setTimeout(() => {
			stopChild(child);
			finish(new Error(`${options.program} timed out`));
		}, timeoutMs);

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		stderrStream.setEncoding("utf8");
		stdoutStream.on("data", (chunk: Buffer) => {
			if (settled) return;
			outputBytes += chunk.length;
			if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
				stopChild(child);
				finish(new MediaOutputLimitError());
				return;
			}
			stdout.push(chunk);
		});
		stderrStream.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code !== 0) {
				finish(new Error(formatProcessError(options.program, code, stderr)));
				return;
			}
			// FFmpeg 9.0.2 maps a declined overwrite (AVERROR_EXIT) to exit code 0.
			// Check its specific diagnostic, including a prompt with logging disabled.
			const refused = options.program === "ffmpeg"
				? stderr.match(/(?:^|\n)(?:\[[^\]\r\n]*\]\s*)*File '([^\r\n]*)' already exists\. (?:Overwrite\? \[y\/N\]|Exiting\.)/)
				: null;
			if (refused) finish(new Error(`ffmpeg refused to overwrite existing file: ${refused[1]}. Choose a new filename or pass -y to overwrite.`));
			else finish();
		});
		if (child.stdin) {
			// FFmpeg may stop after one frame before consuming the container trailer.
			// Its exit status and stderr report failures; an early EPIPE is harmless.
			child.stdin.on("error", () => {});
			child.stdin.end(options.input);
		}
	});
}

function spawnProgram(
	binary: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean; input?: boolean },
): ChildProcess {
	// Node refuses to CreateProcess a .cmd/.bat (EINVAL). cmd.exe can run them.
	if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)) {
		const root = process.env.SystemRoot ?? "C:\\Windows";
		const comspec = process.env.ComSpec ?? join(root, "System32", "cmd.exe");
		return spawn(comspec, ["/d", "/s", "/c", cmdLine([binary, ...args])], {
			cwd: options.cwd,
			env: options.env,
			detached: options.detached,
			stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	}
	return spawn(binary, args, {
		cwd: options.cwd,
		env: options.env,
		detached: options.detached,
		stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
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
