/** Keep an entire async operation in order, including recovery after failures. */
export class SerialQueue {
	private pending: Promise<void> = Promise.resolve();
	private count = 0;

	get idle(): boolean { return this.count === 0; }

	run<T>(operation: () => Promise<T>): Promise<T> {
		this.count++;
		const result = this.pending.then(operation);
		this.pending = result.then(() => undefined, () => undefined);
		return result.finally(() => { this.count--; });
	}
}
