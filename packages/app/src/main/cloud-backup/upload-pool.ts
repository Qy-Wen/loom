/** Stop scheduling after the first failure and settle every in-flight operation before returning. */
export async function parallelFiles<T>(items: readonly T[], concurrency: number, signal: AbortSignal, run: (item: T, index: number, worker: number, signal: AbortSignal) => Promise<void>): Promise<void> {
	signal.throwIfAborted();
	const failed = new AbortController(), transfer = AbortSignal.any([signal, failed.signal]);
	let next = 0, failure: { error: unknown } | undefined;
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async (_value, worker) => {
		try {
			while (next < items.length) { transfer.throwIfAborted(); const index = next++; await run(items[index]!, index, worker, transfer); }
		} catch (error) { if (!failure) { failure = { error }; failed.abort(error); } }
	}));
	signal.throwIfAborted();
	if (failure) throw failure.error;
}

type Waiting = { cost: number; admit(release: () => void): void; signal: AbortSignal; abort(): void };
/** Large files take the entire budget; one oversized file is allowed, without staging others alongside it. */
export class StagingBudget {
	readonly #limit: number;
	#used = 0;
	#waiting: Waiting[] = [];
	constructor(limit: number) { this.#limit = limit; }
	acquire(bytes: number, signal: AbortSignal): Promise<() => void> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const request: Waiting = { cost: Math.min(bytes, this.#limit), admit: resolve, signal, abort: () => {
				this.#waiting = this.#waiting.filter((item) => item !== request); reject(signal.reason); this.#drain();
			} };
			signal.addEventListener("abort", request.abort, { once: true });
			this.#waiting.push(request); this.#drain();
		});
	}
	#drain(): void {
		while (this.#waiting[0] && this.#used + this.#waiting[0].cost <= this.#limit) {
			const request = this.#waiting.shift()!;
			request.signal.removeEventListener("abort", request.abort);
			this.#used += request.cost;
			let released = false;
			request.admit(() => { if (!released) { released = true; this.#used -= request.cost; this.#drain(); } });
		}
	}
}
