import { useEffect, useRef, useState } from "react";
import type { Asset } from "@loom/core";
import { markdownAccess } from "../../../shared/markdown-file.ts";
import { LibraryFileSearch } from "../../components/library-file-search.tsx";
import { useLocale } from "../../locale.tsx";
import { createMarkdownEditor, type MarkdownEditor as MarkdownEditorHandle, type MarkdownMode } from "./codemirror-markdown.ts";
import type { RegisterMarkdownHistory } from "../asset-history.ts";
import { DocumentModeButton } from "./document-mode-button.tsx";
import { FavoriteButton } from "./favorite-button.tsx";
import { markdownFindIconPath } from "./markdown-find.ts";
import { TextFileSave, type TextFiles } from "./text-file-save.ts";

const files: TextFiles = {
	read: (assetId) => window.loom.readMarkdown(assetId),
	save: (assetId, text, revision) => window.loom.saveMarkdown(assetId, text, revision),
};

/** Leaving and returning to a file finds its unsaved text, including a save conflict. */
const sessions = new Map<string, TextFileSave>();

/** One text, save session and CodeMirror view for live editing, reading and source editing. */
export function MarkdownEditor({ asset, assets, favorite, onToggleFavorite, onOpenAsset, registerMarkdown }: {
	asset: Asset;
	assets: Asset[];
	favorite: boolean;
	onToggleFavorite: () => void;
	onOpenAsset?: (assetId: string, heading?: string) => void;
	registerMarkdown?: RegisterMarkdownHistory;
}): React.JSX.Element {
	const { assetId, filename, modifiedAt, relativePath } = asset;
	const { t } = useLocale();
	const [save, setSave] = useState<TextFileSave | null>(() => sessions.get(assetId) ?? null);
	const saveRef = useRef(save);
	const [failure, setFailure] = useState<string | null>(null);
	const [insertIssue, setInsertIssue] = useState<string | null>(null);
	const [pickReference, setPickReference] = useState<((file: Asset) => void) | null>(null);
	const [reading, setReading] = useState(false);
	const [source, setSource] = useState(false);
	const [findOpen, setFindOpen] = useState(false);
	const [, rerender] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const hostRef = useRef<HTMLDivElement>(null);
	const findHostRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<MarkdownEditorHandle | null>(null);
	const libraryRef = useRef({ fromRelativePath: relativePath, assets });
	libraryRef.current = { fromRelativePath: relativePath, assets };
	const openRef = useRef(onOpenAsset);
	openRef.current = onOpenAsset;
	const access = markdownAccess(save?.byteLength ?? asset.size);
	const mode: MarkdownMode = access === "read" || reading ? "read" : access === "source" || source ? "source" : "edit";
	const modeRef = useRef(mode);
	modeRef.current = mode;

	useEffect(() => {
		let cancelled = false;
		setFailure(null);
		void files.read(assetId).then((snapshot) => {
			if (cancelled) return;
			const existing = saveRef.current ?? sessions.get(assetId);
			if (existing) {
				existing.external(snapshot);
				if (saveRef.current === existing) return;
			}
			const session = existing ?? new TextFileSave(assetId, snapshot, files);
			sessions.set(assetId, session);
			saveRef.current = session;
			setSave(session);
		}).catch((cause) => {
			if (!cancelled && !saveRef.current) setFailure(cause instanceof Error ? cause.message : String(cause));
		});
		return () => { cancelled = true; };
	}, [assetId, modifiedAt, asset.size]);

	useEffect(() => {
		if (!save) return;
		const unsubscribe = save.subscribe(() => rerender((version) => version + 1));
		return () => {
			unsubscribe();
			void save.flush().catch(() => undefined).finally(() => {
				if (!save.dirty && sessions.get(assetId) === save && save.state !== "conflict") sessions.delete(assetId);
			});
		};
	}, [save, assetId]);

	useEffect(() => {
		const host = hostRef.current;
		const findHost = findHostRef.current;
		if (!save || !host || !findHost) return;
		setFindOpen(false);
		const editor = createMarkdownEditor(host, findHost, save.text, {
			onChange: (text) => save.edit(text),
			onBlur: () => { void save.flush().catch(() => undefined); },
			onSave: () => { void save.flush().catch(() => undefined); },
			onFindOpenChange: setFindOpen,
			onOpenAsset: (target, anchor) => {
				if (openRef.current) openRef.current(target || assetId, anchor);
				else if ((!target || target === assetId) && anchor) editorRef.current?.scrollToHeading(anchor);
			},
		}, t.preview.editorLabel(filename), libraryRef.current, {
			addRow: t.preview.tableAddRow, addColumn: t.preview.tableAddColumn,
			moveRow: t.preview.tableMoveRow, moveColumn: t.preview.tableMoveColumn,
			searchPhrases: t.preview.searchPhrases,
			find: t.find,
			insertCommands: t.preview.insertCommands,
		}, {
			chooseTableAction: (state) => window.loom.showTableContextMenu(state),
			chooseTextAction: (state) => window.loom.showEditorContextMenu(state),
			chooseDropAction: (filenames) => window.loom.showMarkdownDropMenu(filenames),
			clipboard: (action) => window.loom.runEditorClipboard(action),
			pickAsset: (onPick) => setPickReference(() => onPick),
			importFiles: async (files) => {
				setInsertIssue(null);
				const paths = files.map((file) => window.loom.pathForFile(file)).filter(Boolean);
				if (!paths.length) throw new Error(t.library.importFailed);
				return window.loom.importComposerFiles(paths);
			},
			onDropError: (cause) => setInsertIssue(cause instanceof Error ? cause.message : t.library.importFailed),
		}, modeRef.current);
		editorRef.current = editor;
		const { view } = editor;
		let scroll = view.scrollSnapshot();
		const rememberScroll = () => { scroll = view.scrollSnapshot(); };
		if (registerMarkdown) view.scrollDOM.addEventListener("scroll", rememberScroll, { passive: true });
		const unregister = registerMarkdown?.(assetId, {
			capture: () => {
				const { anchor, head } = view.state.selection.main;
				return { selection: { anchor, head }, scroll: view.dom.isConnected ? view.scrollSnapshot() : scroll };
			},
			restore: (place) => {
				if ("heading" in place) editor.scrollToHeading(place.heading);
				else {
					const length = view.state.doc.length;
					view.dispatch({
						selection: { anchor: Math.min(place.selection.anchor, length), head: Math.min(place.selection.head, length) },
						effects: place.scroll,
					});
				}
			},
		});
		return () => {
			unregister?.();
			view.scrollDOM.removeEventListener("scroll", rememberScroll);
			editorRef.current = null;
			editor.destroy();
		};
	}, [save, assetId, t, registerMarkdown]);

	useEffect(() => { editorRef.current?.setLabel(t.preview.editorLabel(filename)); }, [filename, t]);
	useEffect(() => {
		editorRef.current?.setLibrary({ fromRelativePath: relativePath, assets });
	}, [relativePath, assets]);
	const text = save?.text;
	useEffect(() => { if (text !== undefined) editorRef.current?.setText(text); }, [text]);
	useEffect(() => { editorRef.current?.setMode(mode); }, [mode, save]);

	// Also find from a rendered table cell, or after opening a file while the sidebar still has focus.
	useEffect(() => {
		const find = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
			const root = rootRef.current;
			if (!root || !editorRef.current) return;
			const target = event.target;
			if (target instanceof HTMLElement && !root.contains(target) && target.closest("input, textarea, [contenteditable=true], .cm-editor")) return;
			const overlay = document.querySelector(".preview-overlay");
			if (overlay && !overlay.contains(root)) return;
			event.preventDefault();
			editorRef.current.find();
		};
		// Capture is needed because table cells keep their own key events from the editor's bindings.
		window.addEventListener("keydown", find, true);
		return () => window.removeEventListener("keydown", find, true);
	}, []);

	if (failure) return <div className="preview-placeholder"><strong>{filename}</strong><span>{failure}</span></div>;
	if (!save) return <div className="preview-loading">{t.preview.loadingMarkdown}</div>;
	const flush = () => { void save.flush().catch(() => undefined); };
	const toggleReading = () => { flush(); setSource(false); setReading(mode !== "read"); };
	const toggleLabel = mode === "read" ? t.preview.editMode : t.preview.readingMode;
	return <>
		<div className="markdown-workbench" ref={rootRef}>
			<div className="document-toolbar" role="toolbar" aria-label={t.preview.markdownView}>
				<FavoriteButton favorite={favorite} onToggle={onToggleFavorite} onMouseDown={(event) => event.preventDefault()} />
				<DocumentModeButton previewing={mode === "read"} label={toggleLabel} disabled={access === "read"}
					onMouseDown={(event) => event.preventDefault()} onToggle={toggleReading} />
				{mode !== "read" && <button type="button" aria-label={t.preview.sourceMode} data-tooltip={t.preview.sourceMode}
					aria-pressed={mode === "source"} disabled={access === "source"} onMouseDown={(event) => event.preventDefault()}
					onClick={() => { flush(); setSource((on) => !on); }}>
					<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></svg>
				</button>}
				{mode !== "read" && <button type="button" aria-label={t.preview.insertLabel} data-tooltip={t.preview.insertLabel}
					onMouseDown={(event) => event.preventDefault()} onClick={() => editorRef.current?.insert()}>
					<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
						<path d="M12 5v14M5 12h14" />
					</svg>
				</button>}
				<div className="markdown-toolbar-find" role="group" aria-label={t.find.label}>
					{!findOpen && <button type="button" className="markdown-find-trigger" aria-label={t.find.label}
						aria-expanded="false" data-tooltip={t.find.placeholder} onMouseDown={(event) => event.preventDefault()} onClick={() => editorRef.current?.find()}>
						<svg viewBox="0 0 24 24" className="markdown-find-icon" aria-hidden="true"><path d={markdownFindIconPath} /></svg>
					</button>}
					<div className="markdown-find-panels" ref={findHostRef} />
				</div>
			</div>
			{access !== "live" && <div className="markdown-mode-notice" role="note">{access === "read" ? t.preview.editorReadOnly : t.preview.editorLargeSource}</div>}
			<div className="markdown-editor-body">
				<div className="markdown-editor-input" ref={hostRef} />
				{insertIssue && <div className="markdown-editor-status" role="alert">
					<span className="markdown-editor-problem">{insertIssue}</span>
					<button type="button" onClick={() => setInsertIssue(null)}>{t.app.dismiss}</button>
				</div>}
				{(save.state === "error" || save.state === "conflict") && <div className="markdown-editor-status" role="status">
					{save.state === "error" && <><span className="markdown-editor-problem">{t.preview.editorFailed(save.error ?? "")}</span><button type="button" onClick={flush}>{t.preview.editorRetry}</button></>}
					{save.state === "conflict" && <>
						<span className="markdown-editor-problem">{t.preview.editorConflict}</span>
						<button type="button" onClick={() => { void save.overwrite().catch(() => undefined); }}>{t.preview.editorOverwrite}</button>
						<button type="button" onClick={() => { void save.reload().catch(() => undefined); }}>{t.preview.editorReload}</button>
					</>}
				</div>}
			</div>
		</div>
		{pickReference && <LibraryFileSearch assets={assets} title={t.preview.insertCommands.asset}
			onClose={(file) => {
				setPickReference(null);
				if (file) pickReference(file);
			}} />}
	</>;
}
