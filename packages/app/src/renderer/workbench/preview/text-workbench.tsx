import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Annotation, EditorState, Transaction, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Asset } from "@loom/core";
import { useEffect, useRef, useState } from "react";
import { TEXT_FILE_EDIT_LIMIT_BYTES } from "../../../shared/text-file.ts";
import { assetPreviewUrl, extensionOf } from "../../assets/asset-utils.ts";
import { useLocale } from "../../locale.tsx";
import { DocumentModeButton } from "./document-mode-button.tsx";
import { FavoriteButton } from "./favorite-button.tsx";
import { createHtmlPreviewGuest } from "./html-preview-guest.ts";
import { TextFileSave, type TextFiles } from "./text-file-save.ts";
import { TextPreview } from "./text-preview.tsx";

const htmlFiles: TextFiles = {
	read: (id) => window.loom.readHtml(id),
	save: (id, text, revision) => window.loom.saveHtml(id, text, revision),
};
const textFiles: TextFiles = {
	read: (id) => window.loom.readTextFile(id),
	save: (id, text, revision) => window.loom.saveTextFile(id, text, revision),
};
const sessions = new Map<string, TextFileSave>();
const replaceSource = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
	{ tag: [tags.tagName, tags.keyword], color: "var(--lm-text-accent)" },
	{ tag: [tags.attributeName, tags.propertyName], color: "var(--lm-text-secondary)" },
	{ tag: [tags.string, tags.attributeValue], color: "var(--lm-text-success)" },
	{ tag: [tags.number, tags.bool, tags.null], color: "var(--lm-text-accent)" },
	{ tag: tags.comment, color: "var(--lm-text-muted)" },
]);

function sourceLanguage(extension: string): Extension {
	switch (extension) {
		case ".html": case ".htm": return html();
		case ".css": return css();
		case ".json": return json();
		case ".js": case ".mjs": case ".cjs": return javascript();
		case ".jsx": return javascript({ jsx: true });
		case ".ts": case ".mts": case ".cts": return javascript({ typescript: true });
		case ".tsx": return javascript({ jsx: true, typescript: true });
		default: return [];
	}
}

function flush(save: TextFileSave): void {
	void save.flush().catch(() => undefined);
}

function InteractiveHtmlPreview({ src, title }: { src: string; title: string }): React.JSX.Element {
	const hostRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const guest = createHtmlPreviewGuest(host.ownerDocument, src, title);
		host.append(guest);
		return () => guest.remove();
	}, [src, title]);
	return <div ref={hostRef} className="html-page-preview" />;
}

export function TextWorkbench({ asset, html: renderHtml, favorite, onToggleFavorite }: {
	asset: Asset;
	html: boolean;
	favorite: boolean;
	onToggleFavorite: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const { assetId, filename, modifiedAt, size } = asset;
	const files = renderHtml ? htmlFiles : textFiles;
	const sessionKey = `${renderHtml ? "html" : "text"}:${assetId}`;
	const [editing, setEditing] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [save, setSave] = useState<TextFileSave | null>(() => sessions.get(sessionKey) ?? null);
	const [error, setError] = useState<string | null>(null);
	const [loadAttempt, retryLoad] = useState(0);
	const [, renderSaveState] = useState(0);
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const readOnly = Math.max(save?.byteLength ?? 0, save?.dirty ? 0 : size) > TEXT_FILE_EDIT_LIMIT_BYTES;

	useEffect(() => {
		if (!editing || save) return;
		let cancelled = false;
		setError(null);
		void files.read(assetId).then((snapshot) => {
			if (cancelled) return;
			const session = sessions.get(sessionKey) ?? new TextFileSave(assetId, snapshot, files);
			sessions.set(sessionKey, session);
			setSave(session);
		}).catch((cause: unknown) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => { cancelled = true; };
	}, [assetId, editing, files, loadAttempt, save, sessionKey]);

	useEffect(() => {
		if (!save) return;
		const unsubscribe = save.subscribe(() => renderSaveState((version) => version + 1));
		return () => {
			unsubscribe();
			void save.flush().catch(() => undefined).finally(() => {
				if (!save.dirty && save.state !== "conflict" && sessions.get(sessionKey) === save) sessions.delete(sessionKey);
			});
		};
	}, [save, sessionKey]);

	useEffect(() => {
		if (!save) return;
		let cancelled = false;
		void files.read(assetId).then((snapshot) => {
			if (!cancelled) save.external(snapshot);
		}).catch(() => undefined);
		return () => { cancelled = true; };
	}, [assetId, files, modifiedAt, save, size]);

	const editorLabel = t.preview.editorLabel(filename);
	const extension = extensionOf(filename);
	const searchPhrases = t.preview.searchPhrases;
	useEffect(() => {
		if (!hostRef.current || !save || readOnly) return;
		const view = new EditorView({
			parent: hostRef.current,
			doc: save.text,
			extensions: [
				sourceLanguage(extension), lineNumbers(), history(), drawSelection(), search(),
				EditorView.lineWrapping,
				EditorState.phrases.of(searchPhrases),
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
	}, [editorLabel, extension, readOnly, save, searchPhrases]);

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
		<div className="text-workbench">
			<div className="document-toolbar" role="toolbar" aria-label={renderHtml ? t.preview.htmlView : t.preview.textView}>
				<FavoriteButton favorite={favorite} onToggle={onToggleFavorite} />
				<DocumentModeButton previewing={!editing} label={editing ? t.preview.previewMode : t.preview.editMode}
					disabled={switching || (!editing && readOnly)} onToggle={() => {
						if (editing) void showPreview();
						else setEditing(true);
					}} />
			</div>
			{readOnly && <div className="markdown-mode-notice" role="note">{t.preview.editorReadOnly}</div>}
			{!editing && (renderHtml ? (
				readOnly
					? <iframe className="html-page-preview" src={url.href} title={title} sandbox="" referrerPolicy="no-referrer" />
					: <InteractiveHtmlPreview src={url.href} title={title} />
			) : <TextPreview asset={asset} url={url.href} />)}
			<div className="source-editor" ref={hostRef} hidden={!editing || !save || readOnly} />
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
