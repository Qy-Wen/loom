import { useEffect, useRef, useState } from "react";
import type { Asset } from "@loom/core";
import { markdownAccess } from "../../../shared/markdown-file.ts";
import { useLocale } from "../../locale.tsx";
import { createMarkdownEditor, type MarkdownEditor as MarkdownEditorHandle, type MarkdownMode } from "./codemirror-markdown.ts";
import { requestHeading, takePendingHeading } from "./heading-anchor.ts";
import { markdownFindIconPath } from "./markdown-find.ts";
import { MarkdownSave, type MarkdownFiles } from "./markdown-save.ts";

const files: MarkdownFiles = {
	read: (assetId) => window.loom.readMarkdown(assetId),
	save: (assetId, text, revision) => window.loom.saveMarkdown(assetId, text, revision),
};

/** Leaving and returning to a file finds its unsaved text, including a save conflict. */
const sessions = new Map<string, MarkdownSave>();

/** One text, save session and CodeMirror view for live editing, reading and source editing. */
export function MarkdownEditor({ asset, assets, onOpenAsset }: {
	asset: Asset;
	assets: Asset[];
	onOpenAsset?: (assetId: string) => void;
}): React.JSX.Element {
	const { assetId, filename, modifiedAt, relativePath } = asset;
	const { t } = useLocale();
	const [save, setSave] = useState<MarkdownSave | null>(sessions.get(assetId) ?? null);
	const [failure, setFailure] = useState<string | null>(null);
	const [insertIssue, setInsertIssue] = useState<string | null>(null);
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
		const existing = sessions.get(assetId);
		setFailure(null);
		setInsertIssue(null);
		if (existing) { setSave(existing); return; }
		window.loom.readMarkdown(assetId).then((snapshot) => {
			if (cancelled) return;
			const created = new MarkdownSave(assetId, snapshot, files);
			sessions.set(assetId, created);
			setSave(created);
		}).catch((cause) => {
			if (!cancelled) setFailure(cause instanceof Error ? cause.message : String(cause));
		});
		return () => { cancelled = true; };
	}, [assetId]);

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
		if (!save) return;
		let cancelled = false;
		window.loom.readMarkdown(assetId).then((snapshot) => {
			if (!cancelled) save.external(snapshot);
		}).catch(() => undefined);
		return () => { cancelled = true; };
	}, [save, assetId, modifiedAt, asset.size]);

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
				if (!target || target === assetId) {
					if (anchor) editorRef.current?.scrollToHeading(anchor);
					return;
				}
				if (anchor) requestHeading(target, anchor);
				openRef.current?.(target);
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
			clipboard: (action) => window.loom.runEditorClipboard(action),
			pickAssets: async () => {
				setInsertIssue(null);
				try { return await window.loom.pickComposerLibraryAssets(); }
				catch (cause) {
					setInsertIssue(cause instanceof Error ? cause.message : String(cause));
					return [];
				}
			},
		}, modeRef.current);
		editorRef.current = editor;
		const anchor = takePendingHeading(assetId);
		if (anchor) editor.scrollToHeading(anchor);
		return () => { editorRef.current = null; editor.destroy(); };
	}, [save, assetId, t]);

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
	return (
		<div className="markdown-workbench" ref={rootRef}>
			<div className="markdown-toolbar" role="toolbar" aria-label={t.preview.markdownView}>
				<button type="button" aria-label={toggleLabel} data-tooltip={toggleLabel} aria-pressed={mode === "read"}
					disabled={access === "read"} onMouseDown={(event) => event.preventDefault()} onClick={toggleReading}>
					<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						{mode === "read" ? <><path d="m15 4 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /></> : <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>}
					</svg>
				</button>
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
	);
}
