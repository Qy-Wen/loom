import { useId, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { TracePayload } from "./json-view.tsx";
import { parseTraceJson } from "./json-values.ts";
import { contentText, objectValue, parsedValue, type TraceEvent } from "./trace-events.ts";
import { useTraceLocale } from "./trace-locale.tsx";
import { spanPayload } from "./trace-spans.ts";

const markdown = new MarkdownIt({ html: false, breaks: true });
// Diagnostic previews must not load remote images or navigate to untrusted destinations.
markdown.renderer.rules.image = (tokens, index) => `<span>[image omitted: ${markdown.utils.escapeHtml(tokens[index]!.content)}]</span>`;
markdown.renderer.rules.link_open = () => "<span class=\"trace-preview-link\">";
markdown.renderer.rules.link_close = () => "</span>";
export function PreviewMarkdown({ text }: { text: string }): React.JSX.Element {
	const html = useMemo(() => markdown.render(text), [text]);
	return <div className="trace-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Thinking({ text }: { text: string }): React.JSX.Element {
	const { t } = useTraceLocale();
	const [open, setOpen] = useState(true);
	return <div className="trace-thinking"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{t.preview.thinking} {open ? "▾" : "▸"}</button>{open ? <PreviewMarkdown text={text} /> : null}</div>;
}

function PromptBody({ text }: { text: string | undefined }): React.JSX.Element {
	const { t } = useTraceLocale();
	const [open, setOpen] = useState(true);
	const contentId = useId();
	return <section className="trace-system-prompt">
		<h3><button type="button" className="trace-prompt-toggle" aria-expanded={open} aria-controls={contentId} aria-label={open ? t.preview.collapsePrompt : t.preview.expandPrompt} onClick={() => setOpen(!open)}>{t.preview.promptBody} {open ? "▾" : "▸"}</button></h3>
		<div id={contentId} className="trace-prompt-content" hidden={!open}>{open ? text !== undefined ? <PreviewMarkdown text={text} /> : <p className="trace-empty">{t.preview.promptMissing}</p> : null}</div>
	</section>;
}

export function SystemTools({ event }: { event: TraceEvent }): React.JSX.Element {
	const { t } = useTraceLocale();
	const list = event.toolList;
	const [open, setOpen] = useState(true);
	const contentId = useId();
	return <section className="trace-system-tools">
		<h3><button type="button" className="trace-tools-toggle" aria-expanded={open} aria-controls={contentId} aria-label={open ? t.preview.collapseTools : t.preview.expandTools} onClick={() => setOpen(!open)}>{list?.captured ? t.preview.toolsCount(list.definitions.length) : t.preview.tools} {open ? "▾" : "▸"}</button></h3>
		{/* Keep the JSON tree mounted so its manual folds survive collapsing this section. */}
		<div id={contentId} className="trace-tools-content" hidden={!open}>
			{list?.incomplete ? <p className="trace-note">{t.preview.toolsIncomplete}</p> : null}
			{list?.definitions.length ? <TracePayload text={JSON.stringify(list.definitions)} blobs={event.record.blobs} /> : <p className="trace-empty">{list?.captured ? t.preview.toolsNone : t.preview.toolsMissing}</p>}
		</div>
	</section>;
}

export function EventPreview({ event }: { event: TraceEvent }): React.JSX.Element {
	const { t } = useTraceLocale();
	if (event.kind === "system") return <div>
		<PromptBody text={event.text} />
		<SystemTools event={event} />
	</div>;
	if (event.text !== undefined) return <PreviewMarkdown text={event.text} />;
	if (event.marker) return <p className="trace-empty">{event.summary}</p>;
	const payload = spanPayload(event.span);
	if (event.kind === "assistant") {
		const output = parsedValue(payload?.output);
		const blocks = Array.isArray(output) ? output : output === undefined ? [] : [output];
		return <div className="trace-assistant-preview">
			{blocks.map((block, index) => {
				const object = objectValue(block), text = contentText(block, event.record);
				if (object?.type === "thinking") return text ? <Thinking key={index} text={text} /> : <p key={index} className="trace-empty">{t.preview.thinkingOmitted}</p>;
				if (object?.type === "toolCall") return <section key={index}><h3>{t.preview.call(String(object.name ?? "tool"))}</h3><TracePayload text={JSON.stringify(object.arguments)} /></section>;
				return text ? <PreviewMarkdown key={index} text={text} /> : null;
			})}
			{!blocks.length ? <p className="trace-empty">{payload?.output ?? t.preview.waiting}</p> : null}
		</div>;
	}
	const result = contentText(parsedValue(payload?.output) ?? payload?.output, event.record);
	const resultIsJson = event.kind === "tool" && parseTraceJson(result).kind === "json";
	return <div>
		{event.kind === "tool" ? <section><h3>{t.preview.calledTool}</h3><code className="trace-tool-name">{typeof event.span.attributes["tool.name"] === "string" ? event.span.attributes["tool.name"] : t.preview.toolNameMissing}</code></section> : null}
		{payload?.input ? <section><h3>{t.view.arguments}</h3><TracePayload text={payload.input} blobs={event.record.blobs} /></section> : null}
		{payload?.output ? <section><h3>{t.view.result}</h3>{result && !resultIsJson ? <pre className="trace-tool-output">{result}</pre> : <TracePayload text={result || payload.output} blobs={event.record.blobs} />}</section> : null}
		{!payload ? <p className="trace-empty">{event.summary}</p> : null}
	</div>;
}
