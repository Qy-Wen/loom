import type { SpanAttributes } from "@earendil-works/pi-telemetry";

const LIMIT = 8 * 1024;
const SECRET_KEY = /^(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|client[-_]?secret|cookie|set[-_]?cookie)$/i;

/** Best-effort credential redaction, not a guarantee that arbitrary user text contains no secrets. */
export class TracePrivacy {
	private secrets: string[] = [];
	setSecrets(values: readonly string[]): void { this.secrets = values.filter((value) => value.length > 0).sort((a, b) => b.length - a.length); }
	text(text: string): string {
		let safe = text;
		for (const secret of this.secrets) safe = safe.split(secret).join("[redacted]");
		safe = safe.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
			.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
			.replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"',;&}]+/gi, "$1[redacted]");
		const bytes = Buffer.from(safe);
		return bytes.length <= LIMIT ? safe : bytes.subarray(0, LIMIT).toString("utf8").replace(/\uFFFD$/, "") + "\n…";
	}
	value(value: unknown): string {
		const seen = new WeakSet<object>();
		const clean = (row: unknown, depth: number): unknown => {
			if (typeof row === "string") return this.text(row);
			if (!row || typeof row !== "object") return row;
			if (depth > 12 || seen.has(row)) return "[omitted]";
			seen.add(row);
			if (Array.isArray(row)) return row.slice(0, 200).map((item) => clean(item, depth + 1));
			const object = row as Record<string, unknown>;
			if (object.type === "image" || object.type === "image_url" || object.type === "input_image") return { type: object.type, mimeType: object.mimeType, image: "[omitted]" };
			if (object.type === "thinking" && object.redacted === true) return { type: "thinking", redacted: true };
			return Object.fromEntries(Object.entries(object).slice(0, 200).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : /signature|deferred|headers/i.test(key) ? "[omitted]" : clean(item, depth + 1)]));
		};
		try { return this.text(JSON.stringify(clean(value, 0), null, 2) ?? ""); } catch { return "[unserializable]"; }
	}
	attributes(attributes: SpanAttributes): SpanAttributes {
		return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => [key, SECRET_KEY.test(key) ? "[redacted]" : typeof value === "string" ? this.text(value) : value]));
	}
}
