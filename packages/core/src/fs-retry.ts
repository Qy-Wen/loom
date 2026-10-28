import { setImmediate as yieldToLoop, setTimeout as sleep } from "node:timers/promises";

export interface FileRetryOptions {
	timeoutMs?: number;
	/** Recheck ownership before every filesystem attempt. Guard failures are never retried. */
	beforeAttempt?: () => void;
}

/** Retry short Windows sharing violations without changing the filesystem operation. */
export async function retryWindowsFileOperation<T>(operation: () => Promise<T>, options: FileRetryOptions = {}): Promise<T> {
	const deadline = performance.now() + (options.timeoutMs ?? 2000);
	for (let attempt = 0; ; attempt++) {
		options.beforeAttempt?.();
		try {
			return await operation();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const remaining = deadline - performance.now();
			if (process.platform !== "win32" || remaining <= 0 || !["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(code ?? "")) throw error;
			// Yield promptly to closing readers before backing off for longer-held locks.
			if (attempt < 8) await yieldToLoop();
			else await sleep(Math.min(remaining, 1 + Math.floor(Math.random() * 10)));
		}
	}
}
