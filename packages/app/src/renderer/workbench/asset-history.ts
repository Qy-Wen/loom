import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { StateEffect } from "@codemirror/state";

export type MarkdownPlace =
	| { heading: string }
	| { selection: { anchor: number; head: number }; scroll: StateEffect<unknown> };

export interface MarkdownHistoryView {
	capture(): MarkdownPlace;
	restore(place: MarkdownPlace): void;
}

export type RegisterMarkdownHistory = (assetId: string, view: MarkdownHistoryView) => () => void;

type Entry = { assetId: string; place?: MarkdownPlace };
type History = { entries: Entry[]; index: number };
type Direction = -1 | 1;

const emptyHistory: History = { entries: [], index: -1 };
const maxEntries = 100;

function adjacent(history: History, direction: Direction, assets: ReadonlySet<string>): number {
	for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
		if (assets.has(history.entries[index].assetId)) return index;
	}
	return -1;
}

/** A per-window sequence of opened files and heading jumps, scoped to the open library. */
export function useAssetHistory(root: string | null, visibleAsset: string | null, assets: ReadonlySet<string>) {
	const [history, setHistory] = useState(emptyHistory);
	const latest = useRef(history);
	const library = useRef(root);
	const editor = useRef<{ assetId: string; view: MarkdownHistoryView } | null>(null);
	const pending = useRef<Entry | null>(null);

	function publish(next: History): void {
		latest.current = next;
		setHistory(next);
	}

	function capture(history: History): Entry[] {
		const entries = history.entries.slice();
		const entry = entries[history.index];
		if (entry && editor.current?.assetId === entry.assetId) {
			entries[history.index] = { ...entry, place: editor.current.view.capture() };
		}
		return entries;
	}

	function visit(entry: Entry): void {
		const current = latest.current;
		if (!entry.place && current.entries[current.index]?.assetId === entry.assetId) return;
		const entries = [...capture(current).slice(0, current.index + 1), entry].slice(-maxEntries);
		publish({ entries, index: entries.length - 1 });
	}

	useLayoutEffect(() => {
		if (library.current !== root) {
			library.current = root;
			pending.current = null;
			publish(emptyHistory);
		}
		if (pending.current && pending.current.assetId !== visibleAsset) pending.current = null;
		if (!root) return;
		if (visibleAsset) visit({ assetId: visibleAsset });
		else if (editor.current) {
			const current = latest.current;
			publish({ ...current, entries: capture(current) });
		}
	}, [root, visibleAsset]);

	const registerMarkdown: RegisterMarkdownHistory = useCallback((assetId, view) => {
		const mounted = { assetId, view };
		editor.current = mounted;
		const requested = pending.current;
		if (requested?.assetId === assetId) queueMicrotask(() => {
			if (editor.current !== mounted || pending.current !== requested) return;
			pending.current = null;
			if (requested.place) view.restore(requested.place);
		});
		return () => {
			if (editor.current === mounted) editor.current = null;
		};
	}, []);

	function restore(entry: Entry): void {
		pending.current = null;
		if (!entry.place) return;
		if (entry.assetId === visibleAsset && editor.current?.assetId === entry.assetId) editor.current.view.restore(entry.place);
		else pending.current = entry;
	}

	return {
		canBack: adjacent(history, -1, assets) !== -1,
		canForward: adjacent(history, 1, assets) !== -1,
		registerMarkdown,
		followHeading(assetId: string, heading: string) {
			const entry = { assetId, place: { heading } };
			visit(entry);
			restore(entry);
		},
		move(direction: Direction): string | undefined {
			const current = latest.current;
			const index = adjacent(current, direction, assets);
			if (index === -1) return undefined;
			const entries = capture(current);
			publish({ entries, index });
			restore(entries[index]);
			return entries[index].assetId;
		},
	};
}
