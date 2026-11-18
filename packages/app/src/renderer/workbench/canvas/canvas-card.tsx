import { memo, useMemo, type CSSProperties, type PointerEvent, type KeyboardEvent } from "react";
import type { Asset } from "@loom/core";
import type { CanvasNode } from "../../../shared/canvas.ts";
import { AssetThumbnail } from "../../assets/asset-thumbnail.tsx";
import { extensionOf } from "../../assets/asset-utils.ts";
import { useLocale } from "../../locale.tsx";
import { renderMarkdown } from "../preview/markdown.ts";
import { CanvasMarkdown } from "./canvas-markdown.tsx";

type CanvasCardProps = {
	node: CanvasNode;
	asset: Asset | undefined;
	assets: Asset[];
	selected: boolean;
	editing: boolean;
	style: CSSProperties;
	onMove: (event: PointerEvent, id: string) => void;
	onResize: (event: PointerEvent, id: string) => void;
	onSelect: (id: string, add: boolean) => void;
	onNudge: (event: KeyboardEvent, id: string, resize: boolean) => void;
	onEdit: (id: string | null) => void;
	onText: (id: string, key: "text" | "label", value: string) => void;
	onBlur: () => void;
	onPreview: (asset: Asset) => void;
	onRelink: (id: string) => void;
};

export function CanvasCard({
	node, asset, assets, selected, editing, style, onMove, onResize, onSelect, onNudge, onEdit, onText, onBlur, onPreview, onRelink,
}: CanvasCardProps): React.JSX.Element {
	const { t } = useLocale();
	const name = node.type === "file" ? (asset?.filename ?? node.file?.split("/").at(-1))
		: node.type === "group" ? (node.label || t.canvas.group)
			: node.type === "link" ? node.url : t.canvas.note;
	const url = node.type === "link" && /^https?:\/\//i.test(node.url ?? "") ? node.url : undefined;
	const markdownAsset = node.type === "file" && asset && extensionOf(asset.filename) === ".md" ? asset : undefined;
	return (
		<article className={`canvas-card type-${node.type}${selected ? " selected" : ""}`} style={style} data-node-id={node.id}
			onPointerDown={(event) => {
				if (event.target instanceof Element && event.target.closest("a, input, textarea, button:not(.canvas-handle, .canvas-asset-preview)")) return;
				onMove(event, node.id);
			}}
			onDragStart={(event) => event.preventDefault()}
			onDoubleClick={(event) => {
				if (event.target instanceof Element && event.target.closest("a")) return;
				if (asset && node.type === "file" && event.button === 0) onPreview(asset);
			}}>
			<header className="canvas-card-header">
				<button type="button" className="canvas-handle" title={t.canvas.moveCard}
					aria-label={markdownAsset ? `${t.canvas.preview} ${name}. ${t.canvas.moveCard}` : `${name}. ${t.canvas.moveCard}`}
					aria-pressed={markdownAsset ? undefined : selected}
					onClick={(event) => {
						if (event.detail !== 0) return;
						if (markdownAsset) onPreview(markdownAsset);
						else onSelect(node.id, event.shiftKey);
					}}
					onKeyDown={(event) => onNudge(event, node.id, false)}>
					<span>{name}</span>
				</button>
				{(node.type === "text" || node.type === "group") && (
					<button type="button" className="canvas-card-edit" onClick={() => onEdit(editing ? null : node.id)}>
						{editing ? t.canvas.done : t.common.edit}
					</button>
				)}
			</header>
			{markdownAsset && <CanvasMarkdown asset={markdownAsset} assets={assets} />}
			{node.type === "file" && !markdownAsset && (
				<div className="canvas-card-body">
					{asset ? (
						<button type="button" className="canvas-asset-preview" aria-label={`${t.canvas.preview} ${asset.filename}`}
							onClick={(event) => { if (event.detail === 0) onPreview(asset); }}><AssetThumbnail asset={asset} /></button>
					) : (
						<div className="canvas-missing">
							<span>{t.canvas.missing}</span>
							<button type="button" onClick={() => onRelink(node.id)}>{t.canvas.relink}</button>
						</div>
					)}
				</div>
			)}
			{node.type === "text" && (
				editing ? <textarea className="canvas-note-input" aria-label={t.canvas.textLabel} autoFocus value={node.text ?? ""}
					onBlur={onBlur} onChange={(event) => onText(node.id, "text", event.target.value)} />
					: <NoteBody text={node.text ?? ""} />
			)}
			{node.type === "group" && editing && (
				<input className="canvas-group-title" aria-label={t.canvas.groupLabel} autoFocus value={node.label ?? ""}
					onBlur={onBlur} onChange={(event) => onText(node.id, "label", event.target.value)} />
			)}
			{node.type === "link" && (
				<div className="canvas-card-body canvas-external-link">
					{url ? <a href={url} target="_blank" rel="noopener noreferrer">{url}</a> : node.url}
				</div>
			)}
			<button type="button" className="canvas-resize" title={t.canvas.resizeCard} aria-label={`${name}. ${t.canvas.resizeCard}`}
				onPointerDown={(event) => onResize(event, node.id)}
				onKeyDown={(event) => onNudge(event, node.id, true)} />
		</article>
	);
}

const NoteBody = memo(function NoteBody({ text }: { text: string }): React.JSX.Element {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className="canvas-note thin-scroll markdown-preview-body" dangerouslySetInnerHTML={{ __html: html }} />;
});
