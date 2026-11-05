import { useEffect } from "react";

/** Adapt vendor controls to Loom's tooltip attributes without changing the vendor package. */
export function useChatTooltips(): void {
	useEffect(() => {
		const selector = '[data-slot="tooltip-trigger"][aria-label], button[title]';
		const adapt = (root: Element) => {
			const elements = [...root.querySelectorAll(selector)];
			if (root.matches(selector)) elements.push(root);
			for (const element of elements) {
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
	}, []);
}
