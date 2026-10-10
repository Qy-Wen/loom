import type { LoomUserAttachment } from "@loom/agent";
import { formatAssetRefBlock } from "@loom/agent/attachments";
import { splitStoredAssetText } from "@loom/agent/composer-asset";
import { AssetThumbnail, createAssetThumbnailElement } from "../assets/asset-thumbnail.tsx";
import { useLocale } from "../locale.tsx";
import { useOpenAsset } from "./asset-open.tsx";

export interface ChipLabels {
	remove: string;
	removeNamed: (label: string) => string;
}

const knownAssets = new Map<string, LoomUserAttachment>();

export function rememberComposerAsset(asset: LoomUserAttachment): void {
	knownAssets.set(asset.assetId, asset);
}

export function lookupComposerAsset(assetId: string): LoomUserAttachment | undefined {
	return knownAssets.get(assetId);
}

export function resolveComposerAsset(assetId: string, assets: readonly LoomUserAttachment[]): LoomUserAttachment {
	return assets.find((asset) => asset.assetId === assetId)
		?? knownAssets.get(assetId)
		?? { type: "asset_ref", assetId, path: "file", assetType: "other" };
}

function assetLabel(asset: LoomUserAttachment): string {
	return asset.path.split("/").pop() || asset.path;
}

function chipPreview(asset: LoomUserAttachment) {
	return { assetId: asset.assetId, filename: assetLabel(asset), type: asset.assetType };
}

export function AssetChip({ asset, onRemove }: { asset: LoomUserAttachment; onRemove?: () => void }): React.JSX.Element {
	const openAsset = useOpenAsset();
	const { t } = useLocale();
	const label = assetLabel(asset);
	return (
		<span className="session-asset-chip" contentEditable={false}>
			<AssetThumbnail asset={chipPreview(asset)} />
			<button type="button" className="asset-ref" title={asset.path} onClick={() => openAsset(asset.assetId)}>
				{label}
			</button>
			{onRemove && (
				<button type="button" className="session-asset-chip-remove" aria-label={t.chat.removeNamed(label)} title={t.common.remove} onClick={onRemove}>
					<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
						<path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
					</svg>
				</button>
			)}
		</span>
	);
}

/** User text with library chips in the positions the user placed them. */
export function InlineMessageBody({ text, assets }: { text: string; assets: readonly LoomUserAttachment[] }): React.JSX.Element {
	const parts = splitStoredAssetText(text);
	const used = new Set<string>();
	const nodes: React.JSX.Element[] = [];
	parts.forEach((part, index) => {
		if (part.type === "text") {
			if (part.text) nodes.push(<span key={`t${index}`}>{part.text}</span>);
			return;
		}
		used.add(part.assetId);
		const asset = resolveComposerAsset(part.assetId, assets);
		rememberComposerAsset(asset);
		nodes.push(<AssetChip key={`${part.assetId}:${index}`} asset={asset} />);
	});
	for (const asset of assets) {
		if (used.has(asset.assetId)) continue;
		rememberComposerAsset(asset);
		nodes.push(<AssetChip key={asset.assetId} asset={asset} />);
	}
	return <div className="session-user-text">{nodes}</div>;
}

export function readInlineEditor(root: HTMLElement): string {
	const text = serializeInline(root).replace(/\n+$/, "").replaceAll("\u200b", "");
	const parts = splitStoredAssetText(text);
	if (!parts.some((part) => part.type === "asset" || part.text.trim())) return "";
	return text;
}

export function placeCaretAtStart(root: HTMLElement): void {
	placeCaret(root, null, true);
}

/** Focus the composer and put the caret after `after`, or at the end. */
export function focusInlineEditor(root: HTMLElement, after?: Node | null): void {
	const active = document.activeElement;
	if (active instanceof HTMLElement && active !== root && !root.contains(active)) active.blur();
	window.focus();
	root.focus({ preventScroll: true });
	placeCaret(root, after ?? null, false);
}

function placeCaret(root: HTMLElement, after: Node | null, atStart: boolean): void {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	if (atStart) {
		range.selectNodeContents(root);
		range.collapse(true);
	} else {
		const text = textNodeAfter(root, after);
		range.setStart(text, text.length);
		range.collapse(true);
	}
	selection.removeAllRanges();
	selection.addRange(range);
}

/** Caret next to a contenteditable=false chip does not blink unless it sits in a text node. */
function textNodeAfter(root: HTMLElement, after: Node | null): Text {
	const next = after?.nextSibling ?? (!after ? root.firstChild : null);
	if (next?.nodeType === Node.TEXT_NODE) return next as Text;
	const text = document.createTextNode("\u200b");
	if (after) after.parentNode?.insertBefore(text, after.nextSibling);
	else root.append(text);
	return text;
}

function serializeInline(node: Node): string {
	let out = "";
	let lineStart = true;
	for (const child of node.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			out += child.textContent ?? "";
			lineStart = false;
			continue;
		}
		if (!(child instanceof HTMLElement)) continue;
		const assetId = child.dataset.assetId;
		if (assetId) {
			const known = lookupComposerAsset(assetId);
			const path = child.dataset.assetPath || known?.path;
			const assetType = child.dataset.assetType || known?.assetType;
			if (path && (assetType === "image" || assetType === "video" || assetType === "audio" || assetType === "text" || assetType === "other")) {
				out += formatAssetRefBlock({ type: "asset_ref", assetId, path, assetType });
			}
			lineStart = false;
			continue;
		}
		if (child.tagName === "BR") {
			out += "\n";
			lineStart = true;
			continue;
		}
		if (child.tagName === "DIV" || child.tagName === "P") {
			if (!lineStart && out.length > 0) out += "\n";
			out += serializeInline(child);
			lineStart = true;
			continue;
		}
		out += serializeInline(child);
		lineStart = false;
	}
	return out;
}

export function rangeFromPoint(x: number, y: number): Range | null {
	const doc = document as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	const position = doc.caretPositionFromPoint?.(x, y);
	if (position) {
		const range = document.createRange();
		range.setStart(position.offsetNode, position.offset);
		range.collapse(true);
		return range;
	}
	return doc.caretRangeFromPoint?.(x, y) ?? null;
}

function chipElement(asset: LoomUserAttachment, openAsset: (assetId: string) => void, labels: ChipLabels): HTMLSpanElement {
	const chip = document.createElement("span");
	chip.className = "session-asset-chip";
	chip.contentEditable = "false";
	chip.dataset.assetId = asset.assetId;
	chip.dataset.assetPath = asset.path;
	chip.dataset.assetType = asset.assetType;
	const label = assetLabel(asset);
	chip.append(createAssetThumbnailElement(chipPreview(asset)));
	const name = document.createElement("button");
	name.type = "button";
	name.tabIndex = -1;
	name.className = "asset-ref";
	name.title = asset.path;
	name.textContent = label;
	name.addEventListener("mousedown", (event) => event.preventDefault());
	name.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openAsset(asset.assetId);
	});
	const remove = document.createElement("button");
	remove.type = "button";
	remove.tabIndex = -1;
	remove.className = "session-asset-chip-remove";
	remove.setAttribute("aria-label", labels.removeNamed(label));
	remove.title = labels.remove;
	remove.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>`;
	remove.addEventListener("mousedown", (event) => event.preventDefault());
	remove.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const parent = chip.parentElement;
		chip.remove();
		parent?.dispatchEvent(new InputEvent("input", { bubbles: true }));
	});
	chip.append(name, remove);
	return chip;
}

export function paintInlineEditor(root: HTMLElement, text: string, assets: readonly LoomUserAttachment[], openAsset: (assetId: string) => void, labels: ChipLabels): void {
	const chips = [...root.querySelectorAll<HTMLElement>("[data-asset-id]")];
	root.replaceChildren();
	for (const chip of chips) chip.remove();
	for (const part of splitStoredAssetText(text)) {
		if (part.type === "text") {
			if (part.text) root.append(document.createTextNode(part.text));
			continue;
		}
		const asset = resolveComposerAsset(part.assetId, assets);
		rememberComposerAsset(asset);
		root.append(chipElement(asset, openAsset, labels));
	}
	root.dataset.empty = text ? "false" : "true";
	if (!text && root.contains(document.activeElement)) placeCaretAtStart(root);
}

/** Insert a chip at the drop point. Returns false when the point is outside the editor. */
export function insertChipAtPoint(root: HTMLElement, asset: LoomUserAttachment, x: number, y: number, openAsset: (assetId: string) => void, labels: ChipLabels): boolean {
	const range = rangeFromPoint(x, y);
	if (!range || (range.startContainer !== root && !root.contains(range.startContainer))) return false;
	const host = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
	const existing = host?.closest("[data-asset-id]");
	if (existing && root.contains(existing)) {
		range.setStartAfter(existing);
		range.collapse(true);
	}
	const chip = chipElement(asset, openAsset, labels);
	range.insertNode(chip);
	range.setStartAfter(chip);
	range.collapse(true);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	root.dataset.empty = "false";
	return true;
}

/** Append a chip at the end of the editor. Returns false when that asset is already in the text. */
export function appendChip(root: HTMLElement, asset: LoomUserAttachment, openAsset: (assetId: string) => void, labels: ChipLabels): HTMLElement | null {
	const existing = root.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(asset.assetId)}"]`);
	if (existing) {
		focusInlineEditor(root, existing);
		return existing;
	}
	rememberComposerAsset(asset);
	const chip = chipElement(asset, openAsset, labels);
	const last = root.lastChild;
	if (last && last.nodeName === "BR") root.insertBefore(chip, last);
	else root.append(chip);
	root.dataset.empty = "false";
	focusInlineEditor(root, chip);
	return chip;
}
