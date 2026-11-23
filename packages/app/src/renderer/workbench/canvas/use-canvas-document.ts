import { useEffect, useRef, useState } from "react";
import type { CanvasDocument, CanvasSnapshot } from "../../../shared/canvas.ts";
import { CanvasSave, pendingCanvasSave } from "./canvas-saves.ts";

type History = { document: CanvasDocument; undo: CanvasDocument[]; redo: CanvasDocument[] };
const HISTORY_LIMIT = 60;
const historyOf = (document: CanvasDocument): History => ({ document, undo: [], redo: [] });

export function useCanvasDocument(id: string) {
	const [history, setHistory] = useState<History | null>(null);
	const live = useRef<History | null>(null);
	const saver = useRef<CanvasSave | null>(null);
	const editGroup = useRef<string | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [, refresh] = useState(0);

	function display(next: History): void {
		live.current = next;
		setHistory(next);
	}

	useEffect(() => {
		const existing = pendingCanvasSave(id);
		const queue = existing ?? new CanvasSave(id, "");
		saver.current = queue;
		let disposed = false;
		let request = 0;
		const unsubscribe = queue.subscribe(() => refresh((version) => version + 1));
		const accept = (snapshot: CanvasSnapshot) => {
			queue.reset(snapshot.revision);
			editGroup.current = undefined;
			display(historyOf(snapshot.document));
			setLoadError(null);
		};
		const load = async () => {
			const generation = ++request;
			const previousRevision = queue.revision;
			try {
				const snapshot = await window.loom.readCanvas(id);
				if (disposed || generation !== request || queue.pending || previousRevision !== queue.revision || snapshot.revision === queue.revision) return;
				accept(snapshot);
			} catch (cause) {
				if (!disposed && generation === request && !queue.pending) setLoadError(String(cause));
			}
		};
		if (queue.pending) display(historyOf(queue.pending));
		else void load();

		const unwatch = window.loom.onLibraryChanged((change) => {
			if ((change.type === "upsert" && change.asset.assetId === id)
				|| (change.type === "reset" && change.snapshot.assets.some((asset) => asset.assetId === id))) void load();
		});
		return () => {
			disposed = true;
			live.current = null;
			saver.current = null;
			unsubscribe();
			unwatch();
			void queue.flush().catch(() => undefined);
		};
	}, [id]);

	function record(next: History): void {
		display(next);
		saver.current?.enqueue(next.document);
	}

	function commit(next: CanvasDocument, group?: string): void {
		const current = live.current;
		if (!current || next === current.document) return;
		const undo = group && group === editGroup.current ? current.undo : [...current.undo.slice(1 - HISTORY_LIMIT), current.document];
		editGroup.current = group;
		record({ document: next, undo, redo: [] });
	}

	function undo(): void {
		const current = live.current;
		const previous = current?.undo.at(-1);
		if (!current || !previous) return;
		editGroup.current = undefined;
		record({ document: previous, undo: current.undo.slice(0, -1), redo: [...current.redo, current.document] });
	}

	function redo(): void {
		const current = live.current;
		const next = current?.redo.at(-1);
		if (!current || !next) return;
		editGroup.current = undefined;
		record({ document: next, undo: [...current.undo, current.document], redo: current.redo.slice(0, -1) });
	}

	async function reload(): Promise<void> {
		const queue = saver.current;
		try {
			const snapshot = await window.loom.readCanvas(id);
			if (!queue || saver.current !== queue) return;
			queue.reset(snapshot.revision);
			editGroup.current = undefined;
			display(historyOf(snapshot.document));
			setLoadError(null);
		} catch (cause) {
			setLoadError(String(cause));
		}
	}

	return {
		document: history?.document,
		live,
		commit,
		endGroup: () => { editGroup.current = undefined; },
		undo,
		redo,
		canUndo: !!history?.undo.length,
		canRedo: !!history?.redo.length,
		saving: !!saver.current?.pending,
		error: loadError ?? saver.current?.error,
		conflict: !!saver.current?.conflict,
		flushSave: () => { void saver.current?.flush().catch(() => undefined); },
		reload,
	};
}
