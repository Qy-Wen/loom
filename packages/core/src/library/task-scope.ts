/** One opening of a library. Closing cancels admission, then drains all storage users. */
export class LibraryTaskScope {
	private readonly controller = new AbortController();
	private readonly pending = new Set<Promise<unknown>>();

	get active(): boolean { return !this.controller.signal.aborted; }

	run<T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
		const signal = caller ? AbortSignal.any([this.controller.signal, caller]) : this.controller.signal;
		const task = Promise.resolve().then(async () => {
			signal.throwIfAborted();
			const result = await work(signal);
			signal.throwIfAborted();
			return result;
		});
		this.pending.add(task);
		void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
		return task;
	}

	cancel(): void {
		this.controller.abort(new DOMException("Library operation interrupted", "AbortError"));
	}

	async drain(): Promise<void> {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}
}

/** Only detach external provider calls, never work that can still write to library storage. */
export function abortableProviderCall<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work();
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
