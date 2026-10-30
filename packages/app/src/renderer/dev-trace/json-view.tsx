import { useMemo, useState } from "react";
import { splitTraceBlobs } from "@loom/agent/trace-blob";
import { jsonEntries, jsonPath, jsonString, parseTraceJson, type JsonValue } from "./json-values.ts";
import { useTraceLocale } from "./trace-locale.tsx";

type Blobs = Readonly<Record<string, string>> | undefined;
type NodeProps = {
	value: JsonValue;
	path: string;
	label?: string;
	arrayIndex?: boolean;
	comma?: boolean;
	blobs: Blobs;
	closed: ReadonlySet<string>;
	toggle(path: string): void;
};

function JsonNode({ value, path, label, arrayIndex = false, comma = false, blobs, closed, toggle }: NodeProps): React.JSX.Element {
	const { t } = useTraceLocale();
	const container = value !== null && typeof value === "object";
	const array = Array.isArray(value);
	const entries = jsonEntries(value);
	const string = typeof value === "string" ? jsonString(value, blobs) : undefined;
	const expandable = container ? entries.length > 0 : string?.expandable ?? false;
	const collapsed = expandable && closed.has(path);
	const text = string?.text, preview = string?.preview;
	const renderedString = useMemo(() => text === undefined ? null : JSON.stringify(collapsed ? preview : text), [collapsed, preview, text]);
	const type = value === null ? "null" : typeof value;
	const opening = array ? "[" : "{";
	const closing = array ? "]" : "}";

	return (
		<div className="trace-json-node" data-json-path={path}>
			<div className="trace-json-row">
				{expandable ? <button type="button" className="trace-json-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? t.json.expand : t.json.collapse} ${path || "$"}`} onClick={() => toggle(path)}>{collapsed ? "▸" : "▾"}</button> : null}
				{label === undefined ? null : <><span className={arrayIndex ? "trace-json-index" : "trace-json-key"}>{arrayIndex ? label : JSON.stringify(label)}</span><span>: </span></>}
				{container ? (
					<span>{opening}{collapsed ? <><span className="trace-json-summary">…</span>{closing}<span className="trace-json-count"> {entries.length} {array ? t.json.items : t.json.fields}</span></> : entries.length === 0 ? closing : null}{collapsed || entries.length === 0 ? (comma ? "," : "") : null}</span>
				) : (
					<><span className={`trace-json-value trace-json-${type}`}>{string ? renderedString : JSON.stringify(value)}</span>{string?.missing ? <span className="trace-blob-missing"> {t.json.unavailable}</span> : null}{comma ? "," : ""}</>
				)}
			</div>
			{container && entries.length > 0 && !collapsed ? (
				<>
					<div className="trace-json-children">
						{entries.map(([key, child], index) => <JsonNode key={key} value={child} path={jsonPath(path, key)} label={key} arrayIndex={array} comma={index < entries.length - 1} blobs={blobs} closed={closed} toggle={toggle} />)}
					</div>
					<div className="trace-json-row">{closing}{comma ? "," : ""}</div>
				</>
			) : null}
		</div>
	);
}

function JsonTree({ value, blobs }: { value: JsonValue; blobs: Blobs }): React.JSX.Element {
	const { t } = useTraceLocale();
	// No depth-based auto-collapse: a path is folded only after an explicit user action.
	const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
	const toggle = (path: string) => setClosed((previous) => {
		const next = new Set(previous);
		if (!next.delete(path)) next.add(path);
		return next;
	});
	return <div className="trace-json" role="group" aria-label={t.json.value}><JsonNode value={value} path="" blobs={blobs} closed={closed} toggle={toggle} /></div>;
}

/** Legacy truncated records stay readable; their long text references also default to expanded. */
function TextFallback({ text, blobs }: { text: string; blobs: Blobs }): React.JSX.Element {
	const { t } = useTraceLocale();
	const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
	return (
		<>
			<p className="trace-json-fallback">{t.json.fallback}</p>
			<pre>{splitTraceBlobs(text).map((part, index) => {
				if ("text" in part) return part.text;
				const full = blobs?.[part.hash];
				if (full === undefined) return <span key={index}>{part.previewJson}<span className="trace-blob-missing"> {t.json.unavailable}</span></span>;
				const key = `${index}:${part.hash}`;
				const expanded = !closed.has(key);
				return <span key={index}>
					<span className="trace-blob-value">{expanded ? (part.previewJson === undefined ? full : JSON.stringify(full)) : part.previewJson}</span>
					<button type="button" className="trace-blob-toggle" aria-expanded={expanded} onClick={() => setClosed((previous) => {
						const next = new Set(previous); if (!next.delete(key)) next.add(key); return next;
					})}>{expanded ? t.json.collapse : t.json.expandChars(part.length.toLocaleString())}</button>
				</span>;
			})}</pre>
		</>
	);
}

export function TracePayload({ text, blobs }: { text: string; blobs?: Blobs }): React.JSX.Element {
	const parsed = useMemo(() => parseTraceJson(text), [text]);
	return parsed.kind === "json" ? <JsonTree value={parsed.value} blobs={blobs} /> : <TextFallback text={text} blobs={blobs} />;
}
