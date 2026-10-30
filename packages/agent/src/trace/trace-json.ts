type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const OMITTED = "… (trace content omitted)";
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Bound serialized diagnostics without cutting through JSON syntax. Limits apply to encoded UTF-8 bytes. */
export function boundedTraceJson(value: unknown, limit: number): string {
	const pretty = JSON.stringify(value, null, 2) ?? "null";
	if (bytes(pretty) <= limit) return pretty;
	const compact = JSON.stringify(value) ?? "null";
	if (bytes(compact) <= limit) return compact;
	return encode(JSON.parse(compact) as Json, limit);
}

function encode(value: Json, limit: number): string {
	if (value === null || typeof value !== "object") {
		const json = JSON.stringify(value);
		if (bytes(json) <= limit) return json;
		return typeof value === "string" ? boundedString(value, limit) : "null";
	}
	const array = Array.isArray(value);
	const entries = array ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
	const parts: string[] = [];
	let used = 2; // opening and closing bracket
	let markerKey = "… (trace omitted)";
	while (!array && Object.hasOwn(value, markerKey)) markerKey += "…";
	const notice = array ? JSON.stringify(OMITTED) : `${JSON.stringify(markerKey)}:${JSON.stringify(OMITTED)}`;
	for (let index = 0; index < entries.length; index++) {
		const [key, child] = entries[index]!;
		const prefix = array ? "" : `${JSON.stringify(key)}:`;
		const separator = parts.length ? 1 : 0;
		// Reserve a visible omission notice until the final entry, rather than silently dropping siblings.
		const reserve = index < entries.length - 1 ? bytes(notice) + 1 : 0;
		const available = limit - used - separator - bytes(prefix) - reserve;
		if (available < bytes(JSON.stringify(OMITTED))) {
			if (used + separator + bytes(notice) <= limit) parts.push(notice);
			else return JSON.stringify(OMITTED);
			break;
		}
		const encoded = encode(child, available);
		parts.push(prefix + encoded);
		used += separator + bytes(prefix) + bytes(encoded);
	}
	return `${array ? "[" : "{"}${parts.join(",")}${array ? "]" : "}"}`;
}

function boundedString(value: string, limit: number): string {
	const total = bytes(value);
	const clipped = (length: number) => {
		// Do not split a surrogate pair at the display boundary.
		const prefix = value.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
		return JSON.stringify(`${prefix}\n… (${total - bytes(prefix)} bytes cut)`);
	};
	if (bytes(clipped(0)) > limit) return JSON.stringify(OMITTED);
	let low = 0, high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (bytes(clipped(mid)) <= limit) low = mid;
		else high = mid - 1;
	}
	return clipped(low);
}
