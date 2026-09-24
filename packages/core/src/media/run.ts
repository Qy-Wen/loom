import { spawn } from "node:child_process";
import type { MediaProgram } from "./binaries.ts";
import { resolveMediaBinary } from "./binaries.ts";

export interface RunMediaProcessOptions {
	program: MediaProgram;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
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

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve({ stdout, stderr });
		};

		const timer = setTimeout(() => {
			child.kill();
			finish(new Error(`${options.program} timed out`));
		}, timeoutMs);

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

function formatProcessError(program: MediaProgram, code: number | null, stderr: string): string {
	const last = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
	return last ? `${program} failed: ${last}` : `${program} exited with code ${code ?? "unknown"}`;
}
