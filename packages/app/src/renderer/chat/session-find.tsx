import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { contentToText, type Message } from "@ag-ui/client";
import type { ChatViewProps } from "@loom/ag-ui-react/chat-view";
import MarkdownIt from "markdown-it";
import { isImeComposing } from "../components/ime-composition.ts";
import { useLocale } from "../locale.tsx";

const markdown = new MarkdownIt();
const HIGHLIGHT = "loom-chat-find";
const indexedText = new WeakMap<Message, string>();

function markdownText(source: string): string {
	return markdown.parse(source, {}).map((token) => {
		if (token.type === "fence" || token.type === "code_block") return token.content;
		return token.children?.map((child) => {
			if (child.type === "softbreak") return " ";
			if (child.type === "hardbreak") return "\n";
			return child.type === "text" || child.type === "code_inline" ? child.content : "";
		}).join("") ?? "";
	}).filter(Boolean).join("\n");
}

function messageText(message: Message): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	const cached = indexedText.get(message);
	if (cached !== undefined) return cached;
	const source = contentToText(message.content).replaceAll("\u200b", "");
	const text = message.role === "assistant" ? markdownText(source) : source;
	indexedText.set(message, text);
	return text;
}

function literalPattern(query: string): RegExp {
	return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

function locateMatch(row: HTMLElement, pattern: RegExp, occurrence: number): Range | undefined {
	const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
	const nodes: { node: Node; start: number; end: number }[] = [];
	let block: Element | null = null;
	let text = "";
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const parent = node.parentElement;
		const value = node.nodeValue;
		if (!value || !parent || parent.closest(".agui-chat-toolbar, [data-code-block-header], button:not(.asset-ref), .katex-mathml, script, style")
			|| !parent.checkVisibility({ visibilityProperty: true })) continue;
		const nextBlock = parent.closest("p, pre, li, td, th, blockquote, h1, h2, h3, h4, h5, h6");
		if (nextBlock !== block && text) text += "\n";
		block = nextBlock;
		const start = text.length;
		text += block?.tagName === "PRE" ? value : value.replaceAll("\n", " ");
		nodes.push({ node, start, end: text.length });
	}
	let index = 0;
	for (const match of text.matchAll(pattern)) {
		if (index++ !== occurrence) continue;
		const end = match.index + match[0].length;
		const first = nodes.find((part) => part.start <= match.index && part.end > match.index);
		const last = nodes.find((part) => part.start < end && part.end >= end);
		if (!first || !last) return;
		const range = document.createRange();
		range.setStart(first.node, match.index - first.start);
		range.setEnd(last.node, end - last.start);
		return range;
	}
}

export function useSessionFind(messages: readonly Message[], request: object | null, onClose: () => void) {
	const { t } = useLocale();
	const [query, setQuery] = useState("");
	const [selection, setSelection] = useState({ index: 0, revision: 0 });
	const input = useRef<HTMLInputElement>(null);
	const clearHighlight = useRef<(() => void) | undefined>(undefined);
	const needle = request ? query.trim() : "";
	const searching = needle.length > 0;
	const index = useMemo(() => searching
		? messages.map((message) => ({ messageId: message.id, text: messageText(message) }))
		: [], [messages, searching]);
	const pattern = useMemo(() => literalPattern(needle), [needle]);
	const matches = useMemo(() => searching ? index.flatMap(({ messageId, text }) =>
		Array.from(text.matchAll(pattern), (_, occurrence) => ({ messageId, occurrence }))) : [], [index, pattern, searching]);
	const activeIndex = Math.min(selection.index, matches.length - 1);
	const { messageId, occurrence } = matches[activeIndex] ?? {};

	const reveal = useMemo<ChatViewProps["reveal"]>(() => messageId === undefined || occurrence === undefined ? undefined : ({
		messageId,
		locateText(row) {
			clearHighlight.current?.();
			const update = () => {
				const range = locateMatch(row, pattern, occurrence);
				CSS.highlights?.delete(HIGHLIGHT);
				if (range && typeof Highlight === "function") CSS.highlights?.set(HIGHLIGHT, new Highlight(range));
				row.toggleAttribute("data-chat-find-current", !range || typeof Highlight !== "function" || !CSS.highlights);
				return range;
			};
			const range = update();
			const observer = new MutationObserver(update);
			observer.observe(row, { childList: true, subtree: true, characterData: true });
			clearHighlight.current = () => {
				observer.disconnect();
				CSS.highlights?.delete(HIGHLIGHT);
				row.removeAttribute("data-chat-find-current");
			};
			return range;
		},
	}), [messageId, occurrence, pattern, selection.revision]);

	useLayoutEffect(() => () => {
		clearHighlight.current?.();
		clearHighlight.current = undefined;
	}, [reveal]);

	useLayoutEffect(() => {
		if (!request) return;
		input.current?.focus({ preventScroll: true });
		input.current?.select();
	}, [request]);

	function move(direction: number) {
		if (!matches.length) return;
		setSelection((current) => ({
			index: (Math.min(current.index, matches.length - 1) + direction + matches.length) % matches.length,
			revision: current.revision + 1,
		}));
	}

	const status = matches.length ? t.find.position(String(activeIndex + 1), String(matches.length)) : t.find.none;
	const header = request && <div className="session-find" role="search" aria-label={t.chat.find} onKeyDown={(event) => {
		if (event.key === "Enter" && event.target === input.current && !isImeComposing(event.nativeEvent)) {
			event.preventDefault();
			move(event.shiftKey ? -1 : 1);
		}
	}}>
		<input ref={input} aria-label={t.chat.find} placeholder={t.find.placeholder} value={query} onChange={(event) => {
			setQuery(event.target.value);
			setSelection({ index: 0, revision: 0 });
		}} />
		<span role="status" aria-label={searching ? status : undefined}>
			{searching && (matches.length ? `${activeIndex + 1}/${matches.length}` : t.find.none)}
		</span>
		<button type="button" aria-label={t.find.previous} disabled={!matches.length} onClick={() => move(-1)}>↑</button>
		<button type="button" aria-label={t.find.next} disabled={!matches.length} onClick={() => move(1)}>↓</button>
		<button type="button" aria-label={t.find.close} onClick={onClose}>×</button>
	</div>;

	return { header, reveal };
}
