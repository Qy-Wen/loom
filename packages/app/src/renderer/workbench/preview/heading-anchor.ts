/** A jump to a heading in a file that is still opening. Only the latest request is kept. */
let pending: { assetId: string; anchor: string } | null = null;

export function requestHeading(assetId: string, anchor: string): void {
	pending = { assetId, anchor };
}

/** Take the jump waiting for this file; the editor resolves it against the full text, not the viewport DOM. */
export function takePendingHeading(assetId: string): string | undefined {
	if (pending?.assetId !== assetId) return undefined;
	const { anchor } = pending;
	pending = null;
	return anchor;
}
