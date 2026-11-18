import { useEffect, useRef, useState } from "react";
import { isImeComposing } from "../../components/ime-composition.ts";
import { useLocale } from "../../locale.tsx";
import { MarkdownSave, type MarkdownFiles } from "./markdown-save.ts";

const files: MarkdownFiles = {
	read: (assetId) => window.loom.readMarkdown(assetId),
	save: (assetId, text, revision) => window.loom.saveMarkdown(assetId, text, revision),
};

/** Open editing sessions by asset, so leaving a file and coming back finds the unsaved text still there. */
const sessions = new Map<string, MarkdownSave>();

/**
 * The text of a Markdown file in a plain editable box. Edits save by themselves after a pause, on losing focus
 * and before the window closes. A change made to the file elsewhere is taken in at once when nothing here is
 * unsaved, and otherwise shown as a choice when the save finds it.
 */
export function MarkdownSourceEditor({ assetId, filename, modifiedAt }: { assetId: string; filename: string; modifiedAt: number }): React.JSX.Element {
	const { t } = useLocale();
	const [save, setSave] = useState<MarkdownSave | null>(sessions.get(assetId) ?? null);
	const [failure, setFailure] = useState<string | null>(null);
	const [, rerender] = useState(0);
	const boxRef = useRef<HTMLTextAreaElement>(null);

	// Open the session, or reuse one that still holds unsaved text.
	useEffect(() => {
		let cancelled = false;
		const existing = sessions.get(assetId);
		setFailure(null);
		if (existing) {
			setSave(existing);
			return;
		}
		setSave(null);
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
			// Leaving the file saves what is typed. A session with nothing unsaved is dropped.
			void save.flush().catch(() => undefined).finally(() => {
				if (!save.dirty && sessions.get(assetId) === save && save.state !== "conflict") sessions.delete(assetId);
			});
		};
	}, [save, assetId]);

	// The file changed on disk: the library reports a new modification time.
	useEffect(() => {
		if (!save) return;
		let cancelled = false;
		window.loom.readMarkdown(assetId).then((snapshot) => {
			if (!cancelled) save.external(snapshot);
		}).catch(() => undefined);
		return () => { cancelled = true; };
	}, [save, assetId, modifiedAt]);

	if (failure) return <div className="preview-placeholder"><strong>{filename}</strong><span>{failure}</span></div>;
	if (!save) return <div className="preview-loading">{t.preview.loadingMarkdown}</div>;

	const status = save.state === "saving" ? t.preview.editorSaving
		: save.state === "dirty" ? t.preview.editorUnsaved
		: save.state === "saved" ? t.preview.editorSaved
		: null;
	return (
		<div className="markdown-source-editor">
			<textarea
				ref={boxRef}
				className="text-preview markdown-source-input thin-scroll"
				aria-label={t.preview.editorLabel(filename)}
				spellCheck={false}
				value={save.text}
				onChange={(event) => save.edit(event.target.value)}
				onBlur={() => { void save.flush().catch(() => undefined); }}
				onKeyDown={(event) => {
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !isImeComposing(event.nativeEvent)) {
						event.preventDefault();
						void save.flush().catch(() => undefined);
					}
				}}
			/>
			<div className="markdown-editor-status" role="status">
				{status && <span>{status}</span>}
				{save.state === "error" && (
					<>
						<span className="markdown-editor-problem">{t.preview.editorFailed(save.error ?? "")}</span>
						<button type="button" onClick={() => { void save.flush().catch(() => undefined); }}>{t.preview.editorRetry}</button>
					</>
				)}
				{save.state === "conflict" && (
					<>
						<span className="markdown-editor-problem">{t.preview.editorConflict}</span>
						<button type="button" onClick={() => { void save.overwrite().catch(() => undefined); }}>{t.preview.editorOverwrite}</button>
						<button type="button" onClick={() => { void save.reload().catch(() => undefined); }}>{t.preview.editorReload}</button>
					</>
				)}
			</div>
		</div>
	);
}
