import { createHash } from "node:crypto";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import { traceBlobMark } from "./trace-blob.ts";
import { boundedTraceJson } from "./trace-json.ts";

/** Per-field limit for ordinary payloads. */
const LIMIT = 8 * 1024;
/** Long text inside a model request (system sections, tool definitions) keeps this many characters inline. */
const PREVIEW = 600;
/** Messages kept in a request, taken from the end, so the latest user and tool messages stay visible. */
const MAX_MESSAGES = 200;
/** A full text kept for expansion is still capped, so one runaway value cannot fill the database. */
const BLOB_LIMIT = 4 * 1024 * 1024;
const SECRET_KEY = /^(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|client[-_]?secret|cookie|set[-_]?cookie)$/i;

/** Best-effort credential redaction, not a guarantee that arbitrary user text contains no secrets. */
export class TracePrivacy {
	private secrets: string[] = [];
	/** Receives each full text that was shortened to a preview. */
	private onBlob: ((hash: string, text: string) => void) | undefined;
	setSecrets(values: readonly string[]): void { this.secrets = values.filter((value) => value.length > 0).sort((a, b) => b.length - a.length); }
	text(text: string): string {
		const safe = this.cleaned(text);
		const bytes = Buffer.from(safe);
		return bytes.length <= LIMIT ? safe : bytes.subarray(0, LIMIT).toString("utf8").replace(/\uFFFD$/, "") + `\n… (${bytes.length - LIMIT} of ${bytes.length} bytes cut)`;
	}
	/**
	 * A model request: each message is cleaned and limited on its own, the latest messages are kept, and long text
	 * inside system messages and tool definitions becomes a preview that points at its full text in the record's blobs.
	 */
	request(messages: readonly unknown[], onBlob: (hash: string, text: string) => void): string {
		this.onBlob = onBlob;
		try {
			const kept = messages.slice(-MAX_MESSAGES);
			const dropped = messages.length - kept.length;
			const parts = kept.map((message) => this.value(message, true));
			return `[\n${dropped > 0 ? `  "… ${dropped} earlier messages omitted",\n` : ""}${parts.join(",\n")}\n]`;
		} finally { this.onBlob = undefined; }
	}
	private cleaned(text: string): string {
		let safe = text;
		for (const secret of this.secrets) safe = safe.split(secret).join("[redacted]");
		return safe.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
			.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
			.replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"',;&}]+/gi, "$1[redacted]");
	}
	/** Long text in a request: a preview plus a reference, or the text itself when it is short. */
	private expandable(text: string): string {
		const safe = this.cleaned(text);
		if (!this.onBlob || safe.length <= PREVIEW) return this.text(safe);
		let full = safe;
		if (Buffer.byteLength(full) > BLOB_LIMIT) full = Buffer.from(full).subarray(0, BLOB_LIMIT).toString("utf8").replace(/\uFFFD$/, "") + "\n…";
		const hash = createHash("sha256").update(full).digest("hex").slice(0, 16);
		this.onBlob(hash, full);
		return `${safe.slice(0, PREVIEW)}… ${traceBlobMark(hash, safe.length)}`;
	}
	value(value: unknown, request = false): string {
		const seen = new WeakSet<object>();
		const clean = (row: unknown, depth: number): unknown => {
			if (typeof row === "string") return request ? this.expandable(row) : this.text(row);
			if (!row || typeof row !== "object") return row;
			if (depth > 12 || seen.has(row)) return "[omitted]";
			seen.add(row);
			if (Array.isArray(row)) {
				const items = row.slice(0, 200).map((item) => clean(item, depth + 1));
				if (row.length > 200) items.push(`… (${row.length - 200} items omitted)`);
				return items;
			}
			const object = row as Record<string, unknown>;
			if (object.type === "image" || object.type === "image_url" || object.type === "input_image") return { type: object.type, mimeType: clean(object.mimeType, depth + 1), image: "[omitted]" };
			if (object.type === "thinking" && object.redacted === true) return { type: "thinking", redacted: true };
			const entries = Object.entries(object);
			const kept: [string, unknown][] = entries.slice(0, 200).map(([key, item]) => [this.text(key), SECRET_KEY.test(key) ? "[redacted]" : /signature|deferred|headers/i.test(key) ? "[omitted]" : clean(item, depth + 1)]);
			if (entries.length > 200) {
				let key = "… (trace omitted)";
				while (kept.some(([name]) => name === key)) key += "…";
				kept.push([key, `… (${entries.length - 200} fields omitted)`]);
			}
			return Object.fromEntries(kept);
		};
		try {
			return boundedTraceJson(clean(value, 0), request ? LIMIT * 4 : LIMIT);
		} catch { return JSON.stringify("[unserializable]"); }
	}
	attributes(attributes: SpanAttributes): SpanAttributes {
		return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => [key, SECRET_KEY.test(key) ? "[redacted]" : typeof value === "string" && !key.startsWith("loom.io.") ? this.text(value) : Array.isArray(value) ? value.map((item) => typeof item === "string" ? this.text(item) : item) : value]));
	}
}
