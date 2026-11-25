import type { AssetLookup } from "@loom/core/references";
import { isCanvasFile, type CanvasDocument, type CanvasNode } from "../../../shared/canvas.ts";
import { isMarkdownFile } from "../../../shared/markdown-file.ts";
import { isHtmlFile } from "../../../shared/text-file.ts";
import { createAssetThumbnailElement } from "../../assets/asset-thumbnail-element.ts";
import { renderAssetEmbed } from "../preview/embed-renderers.ts";
import { renderMarkdown } from "../preview/markdown.ts";
import { edgeCurve, nodeBounds } from "./canvas-layout.ts";

const svgNamespace = "http://www.w3.org/2000/svg";
const padding = 12;
let nextArrow = 0;

function renderFile(card: HTMLElement, node: CanvasNode, lookup: AssetLookup): void {
	const asset = node.loom?.assetId ? lookup.byId(node.loom.assetId) : lookup.byPath(node.file ?? "");
	if (!asset) {
		card.classList.add("markdown-broken-reference");
		card.textContent = node.file ?? "";
		return;
	}
	const { filename, relativePath } = asset;
	if (isMarkdownFile(relativePath) || isCanvasFile(relativePath) || isHtmlFile(relativePath)) {
		card.innerHTML = renderAssetEmbed(asset, { target: filename, label: "" }, undefined);
		return;
	}
	const link = card.ownerDocument.createElement("a");
	link.className = "markdown-embed-file markdown-file-link";
	link.href = "#";
	link.dataset.embedLink = "";
	link.dataset.assetId = asset.assetId;
	const name = card.ownerDocument.createElement("span");
	name.textContent = filename;
	link.append(name);
	card.append(link);
	if (asset.type === "image" || asset.type === "video") card.append(createAssetThumbnailElement(asset, "poster"));
}

function renderCard(document: Document, node: CanvasNode, lookup: AssetLookup): HTMLElement {
	const card = document.createElement("span");
	card.className = `markdown-canvas-card type-${node.type}`;
	card.style.left = `${node.x}px`;
	card.style.top = `${node.y}px`;
	card.style.width = `${node.width}px`;
	card.style.height = `${node.height}px`;
	switch (node.type) {
		case "text": card.innerHTML = renderMarkdown(node.text ?? ""); break;
		case "file": renderFile(card, node, lookup); break;
		case "group": card.textContent = node.label ?? ""; break;
		case "link": {
			const url = node.url ?? "";
			if (!/^https?:\/\//i.test(url)) { card.textContent = url; break; }
			const link = document.createElement("a");
			link.href = url;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.textContent = url;
			card.append(link);
			break;
		}
	}
	return card;
}

function renderConnections(plane: HTMLElement, canvas: CanvasDocument): void {
	if (!canvas.edges.length) return;
	const document = plane.ownerDocument;
	const nodes = new Map(canvas.nodes.map((node) => [node.id, node]));
	const lines = document.createElementNS(svgNamespace, "svg");
	lines.setAttribute("class", "markdown-canvas-lines");
	lines.setAttribute("width", "1");
	lines.setAttribute("height", "1");
	lines.setAttribute("aria-hidden", "true");
	const markerId = `markdown-canvas-arrow-${++nextArrow}`;
	const marker = document.createElementNS(svgNamespace, "marker");
	marker.id = markerId;
	marker.setAttribute("markerWidth", "8");
	marker.setAttribute("markerHeight", "8");
	marker.setAttribute("refX", "7");
	marker.setAttribute("refY", "4");
	marker.setAttribute("markerUnits", "userSpaceOnUse");
	marker.setAttribute("orient", "auto-start-reverse");
	const arrow = document.createElementNS(svgNamespace, "path");
	arrow.setAttribute("d", "M 1 1 L 7 4 L 1 7 Z");
	arrow.setAttribute("fill", "var(--lm-text-secondary)");
	marker.append(arrow);
	const defs = document.createElementNS(svgNamespace, "defs");
	defs.append(marker);
	lines.append(defs);
	plane.append(lines);
	for (const edge of canvas.edges) {
		const from = nodes.get(edge.fromNode), to = nodes.get(edge.toNode);
		if (!from || !to) continue;
		const { path, midpoint } = edgeCurve(edge, from, to);
		const line = document.createElementNS(svgNamespace, "path");
		line.setAttribute("d", path);
		if (edge.fromEnd === "arrow") line.setAttribute("marker-start", `url(#${markerId})`);
		if (edge.toEnd !== "none") line.setAttribute("marker-end", `url(#${markerId})`);
		lines.append(line);
		if (edge.label?.trim()) {
			const label = document.createElement("span");
			label.className = "markdown-canvas-edge-label";
			label.style.left = `${midpoint.x}px`;
			label.style.top = `${midpoint.y}px`;
			label.textContent = edge.label;
			plane.append(label);
		}
	}
}

/** Draw a board in document coordinates and fit it to the Markdown block. */
export function mountCanvasEmbed(host: HTMLElement, canvas: CanvasDocument, lookup: AssetLookup): (() => void) | undefined {
	const bounds = nodeBounds(canvas.nodes);
	if (!bounds) return;
	const plane = host.ownerDocument.createElement("span");
	plane.className = "markdown-canvas-plane";
	// Rebase the scene so its position on the original infinite board never affects the preview.
	const nodes = canvas.nodes.map((node) => ({ ...node, x: node.x - bounds.x, y: node.y - bounds.y }));
	renderConnections(plane, { ...canvas, nodes });
	for (const node of nodes) plane.append(renderCard(host.ownerDocument, node, lookup));
	host.append(plane);
	const observer = new ResizeObserver(([entry]) => {
		if (!entry) return;
		const { width, height } = entry.contentRect;
		const scale = Math.min(1, Math.max(1, width - 2 * padding) / bounds.width, Math.max(1, height - 2 * padding) / bounds.height);
		const x = (width - bounds.width * scale) / 2;
		const y = (height - bounds.height * scale) / 2;
		plane.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
	});
	observer.observe(host);
	return () => { observer.disconnect(); plane.remove(); };
}
