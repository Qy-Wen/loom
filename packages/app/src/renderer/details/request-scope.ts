/** Reject late detail reads/results after a selection change or any library reopening. */
export class DetailRequestScope {
	private opening = 0;
	private selection = 0;
	private assetId: string | null = null;
	private readonly requests = new Map<string, number>();

	resetLibrary(): void {
		this.opening++;
		this.select(null);
		this.requests.clear();
	}

	select(assetId: string | null): void {
		if (this.assetId === assetId) return;
		this.assetId = assetId;
		this.selection++;
		this.requests.clear();
	}

	libraryGuard(): () => boolean {
		const opening = this.opening;
		return () => opening === this.opening;
	}

	request(lane: string, assetId: string): () => boolean {
		const opening = this.opening, selection = this.selection;
		const sequence = (this.requests.get(lane) ?? 0) + 1;
		this.requests.set(lane, sequence);
		return () => this.assetId === assetId && this.opening === opening
			&& this.selection === selection && this.requests.get(lane) === sequence;
	}
}
