import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

const copyPath = "M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2";
const checkPath = "m5 12 4 4L19 6";
const feedbackTimers = new WeakMap<HTMLElement, number>();

class CodeCopyWidget extends WidgetType {
	toDOM(view: EditorView): HTMLElement {
		const document = view.dom.ownerDocument;
		const wrapper = document.createElement("span");
		wrapper.className = "cm-live-code-copy";
		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("aria-label", view.state.phrase("Copy code"));
		button.dataset.tooltip = view.state.phrase("Copy code");
		button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${copyPath}" /></svg>`;
		const path = button.querySelector("path")!;
		const status = document.createElement("span");
		status.setAttribute("role", "status");
		wrapper.append(button, status);

		// Clicking a control must leave the current editor selection and focus in place.
		button.addEventListener("mousedown", (event) => { if (event.button === 0) event.preventDefault(); });
		let attempt = 0;
		button.addEventListener("click", async () => {
			const current = ++attempt;
			const { state } = view;
			let node = syntaxTree(state).resolveInner(view.posAtDOM(wrapper), 1);
			while (node.name !== "FencedCode" && node.name !== "CodeBlock") {
				if (!node.parent) return;
				node = node.parent;
			}
			const code = node.getChildren("CodeText").map(({ from, to }) => state.doc.sliceString(from, to)).join("");
			let copied = true;
			try {
				await navigator.clipboard.writeText(code);
			} catch {
				copied = false;
			}
			if (current !== attempt || !wrapper.isConnected) return;
			window.clearTimeout(feedbackTimers.get(wrapper));
			path.setAttribute("d", copied ? checkPath : copyPath);
			status.textContent = state.phrase(copied ? "Copied" : "Copy failed");
			feedbackTimers.set(wrapper, window.setTimeout(() => {
				status.textContent = "";
				path.setAttribute("d", copyPath);
				feedbackTimers.delete(wrapper);
			}, 1500));
		});
		return wrapper;
	}

	destroy(dom: HTMLElement): void {
		window.clearTimeout(feedbackTimers.get(dom));
		feedbackTimers.delete(dom);
	}
}

export const codeCopyButton = Decoration.widget({ widget: new CodeCopyWidget(), side: -1 });

export const liveCodeCopyTheme = EditorView.theme({
	".cm-live-codeblock:is([data-code-language], :has(.cm-live-code-copy))": { minBlockSize: "30px" },
	".cm-live-codeblock:has(.cm-live-code-copy)": { paddingInlineEnd: "38px" },
	".cm-live-fence[data-code-language]::after": {
		content: "attr(data-code-language)", position: "absolute", insetBlockStart: "50%", insetInline: "14px 38px",
		translate: "0 -50%", textBox: "trim-both cap text", lineHeight: "1.2",
		color: "var(--lm-text-muted)", fontSize: "var(--lm-text-size-xs)", textTransform: "lowercase",
		whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none",
	},
	".cm-live-code-copy": {
		position: "absolute", insetBlockStart: "2px", insetInlineEnd: "6px",
		zIndex: "var(--lm-z-raised)", userSelect: "none",
	},
	".cm-live-code-copy > button": {
		display: "grid", placeItems: "center", minInlineSize: "26px", minBlockSize: "26px",
		margin: "0", padding: "0", border: "0", borderRadius: "var(--lm-radius-sm)",
		backgroundColor: "transparent", color: "var(--lm-text-secondary)", cursor: "pointer",
	},
	".cm-live-code-copy > button:hover, .cm-live-code-copy > button:focus-visible": { backgroundColor: "var(--lm-chat-action-hover)" },
	".cm-live-code-copy svg": { inlineSize: "14px", blockSize: "14px" },
	".cm-live-code-copy > [role=status]": {
		position: "absolute", insetInlineEnd: "calc(100% + 4px)", insetBlockStart: "50%", translate: "0 -50%",
		padding: "2px 6px", borderRadius: "var(--lm-radius-sm)", backgroundColor: "var(--lm-surface-hover)",
		color: "var(--lm-text-secondary)", font: "var(--lm-text-size-xs) var(--lm-font-sans)",
		whiteSpace: "nowrap", pointerEvents: "none",
	},
	".cm-live-code-copy > [role=status]:empty": { opacity: "0" },
});
