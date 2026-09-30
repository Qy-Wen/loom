import { spawn } from "node:child_process";
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
 * Single process entry for bundled ffmpeg/ffprobe. A later sandbox replaces this
 * function without changing callers.
 */
export function runMediaProcess(options: RunMediaProcessOptions): Promise<RunMediaProcessResult> {
	const signal = options.signal;
	if (signal?.aborted) return Promise.reject(abortError(options.program));

	const binary = resolveMediaBinary(options.program);
	const timeoutMs = options.timeoutMs ?? (options.program === "ffprobe" ? 20_000 : 10 * 60_000);

	return new Promise((resolve, reject) => {
		const child = spawn(binary, options.args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const onAbort = () => {
			child.kill();
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
			child.kill();
			finish(new Error(`${options.program} timed out`));
		}, timeoutMs);

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(formatProcessError(options.program, code, stderr)));
		});
	});
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
