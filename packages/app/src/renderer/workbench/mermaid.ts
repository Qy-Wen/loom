type Mermaid = typeof import("mermaid").default;

let mermaidReady: Promise<Mermaid> | null = null;
let hydrateChain = Promise.resolve();

function loadMermaid(): Promise<Mermaid> {
	if (!mermaidReady) {
		mermaidReady = import("mermaid").then(({ default: mermaid }) => {
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "neutral",
				fontFamily: '-apple-system, "SF Pro Text", "Segoe UI", sans-serif',
			});
			return mermaid;
		});
	}
	return mermaidReady;
}

function nextMermaidNode(root: ParentNode): HTMLElement | undefined {
	if (root instanceof Element && !root.isConnected) return undefined;
	return [...root.querySelectorAll<HTMLElement>("pre.mermaid")].find(
		(node) => node.getAttribute("data-processed") !== "true" && Boolean(node.textContent?.trim()),
	);
}

async function hydrateOnce(root: ParentNode): Promise<boolean> {
	let mermaid: Mermaid;
	try {
		mermaid = await loadMermaid();
	} catch (error) {
		console.warn("Mermaid failed to load", error);
		return false;
	}
	let rendered = false;
	let index = 0;
	for (;;) {
		const node = nextMermaidNode(root);
		if (!node) return rendered;
		const source = node.textContent ?? "";
		const id = `loom-mermaid-${index}-${Math.random().toString(36).slice(2, 9)}`;
		index += 1;
		try {
			const { svg } = await mermaid.render(id, source);
			if (!node.isConnected) return rendered;
			node.setAttribute("data-processed", "true");
			node.innerHTML = svg;
			rendered = true;
		} catch (error) {
			if (node.isConnected) {
				node.setAttribute("data-processed", "true");
				node.classList.add("mermaid-failed");
			}
			console.warn("Mermaid diagram failed to render", error);
		}
	}
}

/** Render `pre.mermaid` fences left by `renderMarkdown`. Returns true if any diagram was processed. */
export function hydrateMermaid(root: ParentNode): Promise<boolean> {
	const result = hydrateChain.then(() => hydrateOnce(root));
	hydrateChain = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
