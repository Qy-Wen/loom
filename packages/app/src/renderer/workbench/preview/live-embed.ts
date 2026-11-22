import { StateEffect, StateField } from "@codemirror/state";
import { WidgetType, type EditorView } from "@codemirror/view";
import { observeHtmlEmbeds } from "./markdown-html-embed.ts";
import { embeddedReference, hydrateMarkdownNoteEmbeds } from "./markdown-note-embed.ts";
import type { MarkdownRenderContext } from "./markdown.ts";

interface SourceRange {
	from: number;
	to: number;
}

export const revealEmbedSource = StateEffect.define<SourceRange | null>();
export const editingEmbed = StateField.define<SourceRange | null>({
	create: () => null,
	update(value, transaction) {
		if (transaction.state.readOnly) return null;
		for (const effect of transaction.effects) {
			if (effect.is(revealEmbedSource)) return effect.value;
		}
		if (!value) return null;
		const from = transaction.changes.mapPos(value.from, -1);
		const to = transaction.changes.mapPos(value.to, 1);
		const selection = transaction.state.selection.main;
		if (from === to || selection.from < from || selection.to > to) return null;
		return transaction.docChanged ? { from, to } : value;
	},
});

const instances = new WeakMap<HTMLElement, WikiEmbedWidget>();
const observers = new WeakMap<HTMLElement, ResizeObserver>();
const loads = new WeakMap<HTMLElement, AbortController>();

export function embedUnderPointer(view: EditorView, target: Element | null): (SourceRange & { assetId: string; anchor?: string }) | null {
	const element = target?.closest<HTMLElement>(".cm-wiki-embed");
	const widget = element && instances.get(element);
	if (!element || !widget) return null;
	const from = view.posAtDOM(element);
	return { from, to: from + widget.length, assetId: widget.assetId, anchor: widget.anchor };
}

export class WikiEmbedWidget extends WidgetType {
	readonly length: number;
	readonly assetId: string;
	readonly anchor: string | undefined;
	readonly html: string;
	readonly open: ((assetId: string, anchor?: string) => void) | undefined;
	readonly noteContext: MarkdownRenderContext | undefined;

	constructor(length: number, assetId: string, anchor: string | undefined, html: string, open?: (assetId: string, anchor?: string) => void, noteContext?: MarkdownRenderContext) {
		super();
		this.length = length;
		this.assetId = assetId;
		this.anchor = anchor;
		this.html = html;
		this.open = open;
		this.noteContext = noteContext;
	}

	eq(other: WikiEmbedWidget): boolean {
		return this.length === other.length && this.html === other.html && this.noteContext === other.noteContext;
	}

	toDOM(view: EditorView): HTMLElement {
		const element = view.dom.ownerDocument.createElement("span");
		element.className = "cm-wiki-embed";
		element.dataset.length = String(this.length);
		element.innerHTML = this.html;
		instances.set(element, this);
		element.addEventListener("click", (event) => {
			const reference = embeddedReference(event.target);
			if (!reference) return;
			event.preventDefault();
			this.open?.(reference.assetId, reference.anchor);
		});
		const controller = new AbortController();
		loads.set(element, controller);
		if (this.noteContext) void hydrateMarkdownNoteEmbeds(element, { ...this.noteContext, interactiveHtml: true }, controller.signal);
		else observeHtmlEmbeds(element, controller.signal);
		const observer = new ResizeObserver(() => view.requestMeasure());
		observer.observe(element);
		observers.set(element, observer);
		return element;
	}

	destroy(element: HTMLElement): void {
		instances.delete(element);
		observers.get(element)?.disconnect();
		loads.get(element)?.abort();
		observers.delete(element);
		loads.delete(element);
	}
}
