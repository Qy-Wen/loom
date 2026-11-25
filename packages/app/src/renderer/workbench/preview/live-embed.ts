import { StateEffect, StateField } from "@codemirror/state";
import { ViewPlugin, WidgetType, type EditorView } from "@codemirror/view";
import { observeHtmlEmbeds } from "./markdown-html-embed.ts";
import { embeddedReference, hydrateMarkdownEmbeds } from "./markdown-embeds.ts";
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

const setCanvasEmbedHeight = StateEffect.define<number>();
export const canvasEmbedHeight = StateField.define<number>({
	create: () => -1,
	update: (height, transaction) => transaction.effects.find((effect) => effect.is(setCanvasEmbedHeight))?.value ?? height,
});

/** Measure the CSS layout so CodeMirror can reserve the same height outside its viewport. */
export const canvasEmbedSizing = ViewPlugin.fromClass(class {
	private readonly probe: HTMLElement;
	private readonly observer: ResizeObserver;

	constructor(view: EditorView) {
		this.probe = view.dom.ownerDocument.createElement("span");
		this.probe.className = "markdown-canvas-embed-measure";
		this.probe.setAttribute("aria-hidden", "true");
		view.dom.append(this.probe);
		this.observer = new ResizeObserver(([entry]) => {
			const height = entry.contentRect.height;
			if (height > 0 && height !== view.state.field(canvasEmbedHeight)) view.dispatch({ effects: setCanvasEmbedHeight.of(height) });
		});
		this.observer.observe(this.probe);
	}

	destroy(): void {
		this.observer.disconnect();
		this.probe.remove();
	}
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
	readonly context: MarkdownRenderContext | undefined;
	private readonly layoutHeight: number;

	constructor(length: number, assetId: string, anchor: string | undefined, html: string, open?: (assetId: string, anchor?: string) => void, context?: MarkdownRenderContext, estimatedHeight = -1) {
		super();
		this.length = length;
		this.assetId = assetId;
		this.anchor = anchor;
		this.html = html;
		this.open = open;
		this.context = context;
		this.layoutHeight = estimatedHeight;
	}

	get estimatedHeight(): number { return this.layoutHeight; }

	eq(other: WikiEmbedWidget): boolean {
		return this.estimatedHeight === other.estimatedHeight && this.sameContent(other);
	}

	updateDOM(_element: HTMLElement, _view: EditorView, previous: WikiEmbedWidget): boolean {
		return this.sameContent(previous);
	}

	private sameContent(other: WikiEmbedWidget): boolean {
		return this.length === other.length && this.html === other.html && this.context === other.context;
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
		if (this.context) void hydrateMarkdownEmbeds(element, { ...this.context, interactiveHtml: true }, controller.signal);
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
