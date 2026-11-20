import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Asset } from "@loom/core";
import { assetMatches } from "../library/library-filter.ts";
import { parentFolder } from "../library/tree-nav.ts";
import { useLocale } from "../locale.tsx";
import { isImeComposing } from "./ime-composition.ts";
import "./library-file-search.css";

const RESULT_LIMIT = 100;

/** Choose an existing file from the caller's current library snapshot. */
export function LibraryFileSearch({ assets, title, onClose }: {
	assets: readonly Asset[];
	title: string;
	onClose: (file: Asset | null) => void;
}): React.JSX.Element {
	const { language, t } = useLocale();
	const listId = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const sorted = useMemo(() => {
		const { compare } = new Intl.Collator(language, { numeric: true });
		return [...assets].sort((a, b) => compare(a.filename, b.filename) || compare(a.relativePath, b.relativePath));
	}, [assets, language]);
	const matches = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return normalized ? sorted.filter((asset) => assetMatches(asset, normalized)) : sorted;
	}, [sorted, query]);
	const visible = matches.slice(0, RESULT_LIMIT);
	const nameCounts = new Map<string, number>();
	for (const { filename } of visible) nameCounts.set(filename, (nameCounts.get(filename) ?? 0) + 1);
	const index = Math.min(activeIndex, visible.length - 1);
	const active = visible[index];

	useLayoutEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => { if (element?.open) element.close(); };
	}, []);

	useLayoutEffect(() => {
		list.current?.children[index]?.scrollIntoView({ block: "nearest" });
	}, [index, query]);

	function choose(asset: Asset): void {
		dialog.current?.close(asset.assetId);
	}

	function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
		if (isImeComposing(event.nativeEvent) || !active) return;
		const { key } = event;
		if (key === "ArrowDown" || key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex(Math.max(0, Math.min(visible.length - 1, index + (key === "ArrowDown" ? 1 : -1))));
		} else if (key === "Enter") {
			event.preventDefault();
			choose(active);
		}
	}

	return <dialog ref={dialog} className="library-file-search" aria-label={title}
		onKeyDown={(event) => event.stopPropagation()}
		onPointerDown={(event) => {
			if (event.target !== event.currentTarget || event.button !== 0) return;
			const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
			if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) {
				event.preventDefault();
				event.currentTarget.close();
			}
		}}
		onClose={(event) => {
			const element = event.currentTarget;
			if (element.open) return;
			const id = element.returnValue;
			element.returnValue = "";
			onClose(assets.find((asset) => asset.assetId === id) ?? null);
		}}>
		<div className="library-file-field">
			<input ref={input} type="text" role="combobox" inputMode="search" autoFocus
				autoCapitalize="off" spellCheck={false} enterKeyHint="done" aria-label={t.fileSearch.search}
				aria-autocomplete="list" aria-expanded={Boolean(active)} aria-controls={listId}
				aria-activedescendant={active ? `${listId}-${index}` : undefined}
				placeholder={t.fileSearch.placeholder} value={query}
				onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
				onKeyDown={onSearchKeyDown} />
			{query && <button type="button" className="library-file-clear" aria-label={t.browser.clearSearch}
				onClick={() => {
					setQuery("");
					setActiveIndex(0);
					input.current?.focus();
				}}><span aria-hidden="true">×</span></button>}
		</div>
		<ul ref={list} id={listId} className="library-file-results thin-scroll" role="listbox"
			hidden={!active} aria-label={t.fileSearch.results}>
			{visible.map((asset, row) => <li key={asset.assetId} id={`${listId}-${row}`} role="option"
				aria-selected={index === row} aria-label={asset.relativePath} title={asset.relativePath} onClick={() => choose(asset)}>
				<span className="library-file-name">{asset.filename}</span>
				{(nameCounts.get(asset.filename) ?? 0) > 1 && <span className="library-file-path">{parentFolder(asset.relativePath) || "/"}</span>}
			</li>)}
		</ul>
		{!matches.length && <p className="library-file-message" role="status">{t.fileSearch.noResults}</p>}
		{matches.length > RESULT_LIMIT && <p className="library-file-message">{t.fileSearch.resultLimit(RESULT_LIMIT)}</p>}
		<footer className="library-file-shortcuts">
			<span><kbd>↑↓</kbd> {t.fileSearch.navigate}</span>
			<span><kbd>↵</kbd> {t.fileSearch.select}</span>
			<span><kbd>Esc</kbd> {t.fileSearch.dismiss}</span>
		</footer>
	</dialog>;
}
