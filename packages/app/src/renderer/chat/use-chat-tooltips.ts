import { useEffect } from "react";
import { useLocale } from "../locale.tsx";

/** Adapt vendor controls to Loom's tooltip attributes without changing the vendor package. */
export function useChatTooltips(): void {
	const { t } = useLocale();
	const copyCode = t.chat.copyCode;
	useEffect(() => {
		const codeCopyButton = "[data-code-block-header] > div > button:not(:has(> svg.lucide-download))";
		const selector = `[data-slot="tooltip-trigger"][aria-label], button[title], ${codeCopyButton}`;
		const adapt = (root: Element) => {
			const elements = [...root.querySelectorAll(selector)];
			if (root.matches(selector)) elements.push(root);
			for (const element of elements) {
				if (element.matches(codeCopyButton) && element.getAttribute("aria-label") !== copyCode) {
					element.setAttribute("aria-label", copyCode);
				}
				const text = element.getAttribute("title") ?? element.getAttribute("aria-label");
				if (text) element.setAttribute("data-tooltip", text);
				element.removeAttribute("title");
			}
		};
		adapt(document.body);
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "attributes") adapt(record.target as Element);
				else for (const node of record.addedNodes) if (node instanceof Element) adapt(node);
			}
		});
		observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label"] });
		return () => observer.disconnect();
	}, [copyCode]);
}
