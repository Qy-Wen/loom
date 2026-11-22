import { html } from "@codemirror/lang-html";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Annotation, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Asset } from "@loom/core";
import { useEffect, useRef, useState } from "react";
import { HTML_PREVIEW_PARTITION, HTML_PREVIEW_SCHEME } from "../../../shared/html-preview.ts";
import { TEXT_FILE_EDIT_LIMIT_BYTES } from "../../../shared/text-file.ts";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { useLocale } from "../../locale.tsx";
import { DocumentModeButton } from "./document-mode-button.tsx";
import { FavoriteButton } from "./favorite-button.tsx";
import { TextFileSave, type TextFiles } from "./text-file-save.ts";

const files: TextFiles = {
	read: (id) => window.loom.readHtml(id),
	save: (id, text, revision) => window.loom.saveHtml(id, text, revision),
};
const sessions = new Map<string, TextFileSave>();
const replaceSource = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
	{ tag: [tags.tagName, tags.keyword], color: "var(--lm-text-accent)" },
	{ tag: [tags.attributeName, tags.propertyName], color: "var(--lm-text-secondary)" },
	{ tag: [tags.string, tags.attributeValue], color: "var(--lm-text-success)" },
	{ tag: tags.comment, color: "var(--lm-text-muted)" },
]);

function flush(save: TextFileSave): void {
	void save.flush().catch(() => undefined);
}

function InteractiveHtmlPreview({ src, title }: { src: string; title: string }): React.JSX.Element {
	const hostRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const guest = document.createElement("webview");
		guest.setAttribute("partition", HTML_PREVIEW_PARTITION);
		guest.setAttribute("src", src);
		guest.setAttribute("aria-label", title);
		hostRef.current?.append(guest);
		return () => guest.remove();
	}, [src, title]);
	return <div ref={hostRef} className="html-page-preview" />;
}

export function HtmlWorkbench({ asset, favorite, onToggleFavorite }: {
	asset: Asset;
	favorite: boolean;
	onToggleFavorite: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const { assetId, filename, modifiedAt, size } = asset;
	const [editing, setEditing] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [save, setSave] = useState<TextFileSave | null>(() => sessions.get(assetId) ?? null);
	const [error, setError] = useState<string | null>(null);
	const [loadAttempt, retryLoad] = useState(0);
	const [, renderSaveState] = useState(0);
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const readOnly = (save?.byteLength ?? size) > TEXT_FILE_EDIT_LIMIT_BYTES;

	useEffect(() => {
		if (!editing || save) return;
		let cancelled = false;
		setError(null);
		void files.read(assetId).then((snapshot) => {
			if (cancelled) return;
			const session = sessions.get(assetId) ?? new TextFileSave(assetId, snapshot, files);
			sessions.set(assetId, session);
			setSave(session);
		}).catch((cause: unknown) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => { cancelled = true; };
	}, [assetId, editing, loadAttempt, save]);

	useEffect(() => {
		if (!save) return;
		const unsubscribe = save.subscribe(() => renderSaveState((version) => version + 1));
		return () => {
			unsubscribe();
			void save.flush().catch(() => undefined).finally(() => {
				if (!save.dirty && save.state !== "conflict" && sessions.get(assetId) === save) sessions.delete(assetId);
			});
		};
	}, [save, assetId]);

	useEffect(() => {
		if (!save) return;
		let cancelled = false;
		void files.read(assetId).then((snapshot) => {
			if (!cancelled) save.external(snapshot);
		}).catch(() => undefined);
		return () => { cancelled = true; };
	}, [assetId, modifiedAt, save, size]);

	const editorLabel = t.preview.editorLabel(filename);
	useEffect(() => {
		if (!hostRef.current || !save || readOnly) return;
		const view = new EditorView({
			parent: hostRef.current,
			doc: save.text,
			extensions: [
				html(), lineNumbers(), history(), drawSelection(), search(),
				EditorView.lineWrapping,
				syntaxHighlighting(highlight),
				EditorView.contentAttributes.of({ "aria-label": editorLabel, spellcheck: "false" }),
				keymap.of([
					{ key: "Mod-s", preventDefault: true, run: () => { flush(save); return true; } },
					indentWithTab, ...searchKeymap, ...historyKeymap, ...defaultKeymap,
				]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(replaceSource))) {
						save.edit(update.state.doc.toString());
					}
				}),
				EditorView.domEventHandlers({ blur: () => { flush(save); } }),
			],
		});
		view.scrollDOM.classList.add("thin-scroll");
		viewRef.current = view;
		return () => { viewRef.current = null; view.destroy(); };
	}, [editorLabel, readOnly, save]);

	const text = save?.text;
	useEffect(() => {
		const view = viewRef.current;
		if (view && text !== undefined && text !== view.state.doc.toString()) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: text },
				annotations: [replaceSource.of(true), Transaction.addToHistory.of(false)],
			});
		}
	}, [text]);

	useEffect(() => {
		if (editing) viewRef.current?.focus();
	}, [editing, save]);

	async function showPreview(): Promise<void> {
		setSwitching(true);
		try {
			await save?.flush();
			setEditing(false);
		} catch { /* The save status offers recovery in the editor. */ }
		finally { setSwitching(false); }
	}

	const url = new URL(assetPreviewUrl(asset));
	if (save) url.searchParams.set("revision", save.revision);
	const title = t.preview.title(filename);
	return (
		<div className="html-workbench">
			<div className="document-toolbar" role="toolbar" aria-label={t.preview.htmlView}>
				<FavoriteButton favorite={favorite} onToggle={onToggleFavorite} />
				<DocumentModeButton previewing={!editing} label={editing ? t.preview.previewMode : t.preview.editMode}
					disabled={switching || (!editing && readOnly)} onToggle={() => {
						if (editing) void showPreview();
						else setEditing(true);
					}} />
			</div>
			{readOnly && <div className="markdown-mode-notice" role="note">{t.preview.editorReadOnly}</div>}
			{!editing && (readOnly
				? <iframe className="html-page-preview" src={url.href} title={title} sandbox="" referrerPolicy="no-referrer" />
				: <InteractiveHtmlPreview src={`${HTML_PREVIEW_SCHEME}://${url.host}${url.pathname}${url.search}`} title={title} />)}
			<div className="html-source" ref={hostRef} hidden={!editing || !save || readOnly} />
			{editing && !save && (error
				? <div className="markdown-editor-status" role="alert"><span className="markdown-editor-problem">{error}</span><button type="button" onClick={() => retryLoad((attempt) => attempt + 1)}>{t.preview.editorRetry}</button></div>
				: <div className="preview-loading" role="status">{t.preview.loadingText}</div>)}
			{editing && save && (save.state === "error" || save.state === "conflict") && (
				<div className="markdown-editor-status" role="status">
					{save.state === "error" && <><span className="markdown-editor-problem">{t.preview.editorFailed(save.error ?? "")}</span><button type="button" onClick={() => flush(save)}>{t.preview.editorRetry}</button></>}
					{save.state === "conflict" && <>
						<span className="markdown-editor-problem">{t.preview.editorConflict}</span>
						<button type="button" onClick={() => void save.overwrite().catch(() => undefined)}>{t.preview.editorOverwrite}</button>
						<button type="button" onClick={() => void save.reload().catch(() => undefined)}>{t.preview.editorReload}</button>
					</>}
				</div>
			)}
		</div>
	);
}
