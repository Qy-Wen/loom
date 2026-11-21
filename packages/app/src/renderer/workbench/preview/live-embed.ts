import { StateEffect, StateField } from "@codemirror/state";
import { WidgetType, type EditorView } from "@codemirror/view";
import { EMBED_LINK_SELECTOR } from "./embed-renderers.ts";

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

	constructor(length: number, assetId: string, anchor: string | undefined, html: string, open?: (assetId: string, anchor?: string) => void) {
		super();
		this.length = length;
		this.assetId = assetId;
		this.anchor = anchor;
		this.html = html;
		this.open = open;
	}

	eq(other: WikiEmbedWidget): boolean {
		return this.length === other.length && this.html === other.html;
	}

	toDOM(view: EditorView): HTMLElement {
		const element = view.dom.ownerDocument.createElement("span");
		element.className = "cm-wiki-embed";
		element.dataset.length = String(this.length);
		element.innerHTML = this.html;
		instances.set(element, this);
		element.addEventListener("click", (event) => {
			if (!(event.target instanceof Element) || !event.target.closest(EMBED_LINK_SELECTOR)) return;
			event.preventDefault();
			this.open?.(this.assetId, this.anchor);
		});
		const observer = new ResizeObserver(() => view.requestMeasure());
		observer.observe(element);
		observers.set(element, observer);
		return element;
	}

	destroy(element: HTMLElement): void {
		instances.delete(element);
		observers.get(element)?.disconnect();
		observers.delete(element);
	}
}
