/** Compare the edited draft with its baseline, never with a later server response. */
export function changedFields<T extends object>(before: T, after: T): Partial<T> {
	return Object.fromEntries(Object.entries(after).filter(([key, value]) =>
		JSON.stringify(value) !== JSON.stringify(before[key as keyof T]))) as Partial<T>;
}
