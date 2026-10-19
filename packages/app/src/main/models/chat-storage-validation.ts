import { assertJson } from "@loom/agent/chat-models";

export function validateStorageId(id: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) throw new Error("Invalid Chat storage identifier");
}

/** Native TS objects may omit optional fields by setting undefined; reject other non-JSON values. */
export function normalizeStorageJson(value: unknown): unknown {
	const active = new Set<object>();
	const visit = (value: unknown, depth: number): unknown => {
		if (!value || typeof value !== "object") return value;
		if (depth > 64 || active.has(value)) throw new Error("Invalid JSON storage value");
		if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Invalid JSON storage object");
		active.add(value);
		const result = Array.isArray(value) ? Array.from(value, (entry) => visit(entry, depth + 1))
			: Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, visit(entry, depth + 1)]));
		active.delete(value); return result;
	};
	const normalized = visit(value, 0); assertJson(normalized); return normalized;
}
