import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export const LIVE_IMAGE_MAX_HEIGHT = 360;

type ImageSize = { width: number; height: number };
const setImageSize = StateEffect.define<{ src: string; size: ImageSize }>();
const setContentWidth = StateEffect.define<number>();

export const imageLayout = StateField.define<{ width: number; sizes: ReadonlyMap<string, ImageSize> }>({
	create: () => ({ width: Infinity, sizes: new Map() }),
	update(layout, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setContentWidth) && effect.value !== layout.width) {
				layout = { ...layout, width: effect.value };
			} else if (effect.is(setImageSize)) {
				const { src, size } = effect.value;
				const known = layout.sizes.get(src);
				if (known?.width !== size.width || known.height !== size.height) {
					layout = { ...layout, sizes: new Map(layout.sizes).set(src, size) };
				}
			}
		}
		return layout;
	},
});

function measureImage(view: EditorView, src: string, image: HTMLImageElement): void {
	const { naturalWidth: width, naturalHeight: height } = image;
	const layout = view.state.field(imageLayout, false);
	if (!layout || !view.dom.isConnected || width === 0 || height === 0) return;
	const known = layout.sizes.get(src);
	if (known?.width === width && known.height === height) return;
	view.dispatch({ effects: setImageSize.of({ src, size: { width, height } }) });
}

export class ImageWidget extends WidgetType {
	readonly src: string;
	readonly alt: string;
	private readonly block: boolean;
	private readonly size: ImageSize | undefined;
	private readonly layoutHeight: number;

	constructor(src: string, alt: string, block: boolean, state: EditorState) {
		super();
		this.src = src;
		this.alt = alt;
		this.block = block;
		const layout = state.field(imageLayout, false);
		this.size = layout?.sizes.get(src);
		this.layoutHeight = this.size && layout
			? Math.min(this.size.height, LIVE_IMAGE_MAX_HEIGHT, layout.width * this.size.height / this.size.width)
			: -1;
	}

	get estimatedHeight(): number {
		return this.layoutHeight;
	}

	eq(other: ImageWidget): boolean {
		return this.src === other.src && this.alt === other.alt && this.block === other.block && this.size === other.size && this.estimatedHeight === other.estimatedHeight;
	}

	toDOM(view: EditorView): HTMLElement {
		const image = view.dom.ownerDocument.createElement("img");
		image.className = "cm-live-image";
		image.alt = this.alt;
		image.draggable = false;
		if (this.block) image.style.display = "block";
		if (this.size) {
			const { width, height } = this.size;
			image.style.width = `${Math.min(width, LIVE_IMAGE_MAX_HEIGHT * width / height)}px`;
			image.style.aspectRatio = `${width} / ${height}`;
		}
		image.addEventListener("mousedown", (event) => {
			if (view.state.readOnly || event.button !== 0 || event.metaKey || event.ctrlKey) return;
			event.preventDefault();
			view.dispatch({ selection: { anchor: view.posAtDOM(image) } });
			view.focus();
		});
		image.addEventListener("load", () => {
			if (!image.isConnected) return;
			measureImage(view, this.src, image);
			view.requestMeasure();
		}, { once: true });
		image.src = this.src;
		return image;
	}
}

/** Give CodeMirror image dimensions before it draws the viewport. External images load through their visible widgets. */
export function liveImageSizing(decorations: StateField<DecorationSet>): Extension {
	return [imageLayout, decorations, ViewPlugin.fromClass(class {
		private readonly probes = new Map<string, HTMLImageElement>();
		private readonly observer: ResizeObserver;

		constructor(view: EditorView) {
			this.observer = new ResizeObserver(([entry]) => {
				const width = entry.contentRect.width;
				if (width > 0 && width !== view.state.field(imageLayout, false)?.width && view.dom.isConnected) {
					view.dispatch({ effects: setContentWidth.of(width) });
				}
			});
			this.observer.observe(view.contentDOM);
		}

		update({ view, state, startState }: ViewUpdate): void {
			const images = state.field(decorations);
			if (images === startState.field(decorations, false)) return;
			const wanted = new Set<string>();
			const { sizes } = state.field(imageLayout);
			images.between(0, state.doc.length, (_from, _to, decoration) => {
				const widget = decoration.spec.widget;
				if (!(widget instanceof ImageWidget) || !widget.src.startsWith("loom-asset:") || sizes.has(widget.src)) return;
				wanted.add(widget.src);
				if (this.probes.has(widget.src)) return;
				const probe = view.dom.ownerDocument.createElement("img");
				probe.fetchPriority = "low";
				probe.onload = () => measureImage(view, widget.src, probe);
				probe.src = widget.src;
				this.probes.set(widget.src, probe);
			});
			for (const [src, probe] of this.probes) {
				if (!wanted.has(src)) { probe.onload = null; this.probes.delete(src); }
			}
		}

		destroy(): void {
			this.observer.disconnect();
			for (const probe of this.probes.values()) probe.onload = null;
			this.probes.clear();
		}
	})];
}
