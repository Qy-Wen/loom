/** Serialize settings writes so slow earlier edits cannot overwrite newer ones. */
export class SettingsSaveQueue {
	private pending: Promise<void> = Promise.resolve();
	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}
	async flush(): Promise<void> { await this.pending; }
}
