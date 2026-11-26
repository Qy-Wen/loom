/** Move a tab before another tab, or to the end when no anchor is given. */
export function moveTabBefore(ids: readonly string[], id: string, beforeId: string | null): readonly string[] {
	const from = ids.indexOf(id);
	if (from < 0 || id === beforeId || (ids[from + 1] ?? null) === beforeId) return ids;
	const rest = ids.filter((candidate) => candidate !== id);
	const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
	if (at < 0) return ids;
	return [...rest.slice(0, at), id, ...rest.slice(at)];
}
