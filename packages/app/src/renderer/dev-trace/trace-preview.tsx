import { useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { TracePayload } from "./json-view.tsx";
import { contentText, objectValue, parsedValue, type TraceEvent } from "./trace-events.ts";
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
	const [open, setOpen] = useState(true);
	return <div className="trace-thinking"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>思考 {open ? "▾" : "▸"}</button>{open ? <PreviewMarkdown text={text} /> : null}</div>;
}

export function EventPreview({ event }: { event: TraceEvent }): React.JSX.Element {
	if (event.text !== undefined) return <PreviewMarkdown text={event.text} />;
	const payload = spanPayload(event.span);
	if (event.kind === "assistant") {
		const output = parsedValue(payload?.output);
		const blocks = Array.isArray(output) ? output : output === undefined ? [] : [output];
		return <div className="trace-assistant-preview">
			{blocks.map((block, index) => {
				const object = objectValue(block), text = contentText(block, event.record);
				if (object?.type === "thinking") return text ? <Thinking key={index} text={text} /> : <p key={index} className="trace-empty">思考内容已省略</p>;
				if (object?.type === "toolCall") return <section key={index}><h3>调用 · {String(object.name ?? "tool")}</h3><TracePayload text={JSON.stringify(object.arguments)} /></section>;
				return text ? <PreviewMarkdown key={index} text={text} /> : null;
			})}
			{!blocks.length ? <p className="trace-empty">{payload?.output ?? "等待模型输出…"}</p> : null}
		</div>;
	}
	const result = contentText(parsedValue(payload?.output) ?? payload?.output, event.record);
	return <div>
		{payload?.input ? <section><h3>参数</h3><TracePayload text={payload.input} blobs={event.record.blobs} /></section> : null}
		{payload?.output ? <section><h3>结果</h3>{result ? <pre className="trace-tool-output">{result}</pre> : <TracePayload text={payload.output} blobs={event.record.blobs} />}</section> : null}
		{!payload ? <p className="trace-empty">{event.summary}</p> : null}
	</div>;
}
