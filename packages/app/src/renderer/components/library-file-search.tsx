import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Asset } from "@loom/core";
import { assetMatches } from "../library/library-filter.ts";
import { parentFolder } from "../library/tree-nav.ts";
import { useLocale } from "../locale.tsx";
import { isImeComposing } from "./ime-composition.ts";
import "./library-file-search.css";

const RESULT_LIMIT = 100;

/** Choose existing files from the caller's current library snapshot. */
export function LibraryFileSearch({ assets, title, multiple = false, onClose }: {
	assets: readonly Asset[];
	title: string;
	multiple?: boolean;
	onClose: (files: Asset[]) => void;
}): React.JSX.Element {
	const { language, t } = useLocale();
	const heading = useId();
	const listId = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const confirmed = useRef<string[]>([]);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const byId = useMemo(() => new Map(assets.map((asset) => [asset.assetId, asset])), [assets]);
	const sorted = useMemo(() => {
		const { compare } = new Intl.Collator(language, { numeric: true });
		return [...assets].sort((a, b) => compare(a.filename, b.filename) || compare(a.relativePath, b.relativePath));
	}, [assets, language]);
	const matches = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return normalized ? sorted.filter((asset) => assetMatches(asset, normalized)) : sorted;
	}, [sorted, query]);
	const visible = matches.slice(0, RESULT_LIMIT);
	const index = Math.min(activeIndex, visible.length - 1);
	const active = visible[index];
	const selection = [...selected].filter((id) => byId.has(id));

	useLayoutEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => { if (element?.open) element.close(); };
	}, []);

	useLayoutEffect(() => {
		list.current?.children[index]?.scrollIntoView({ block: "nearest" });
	}, [index, query]);

	function accept(): void {
		const ids = selection.length ? selection : active ? [active.assetId] : [];
		if (ids.length) close(ids);
	}

	function close(ids: string[]): void {
		confirmed.current = ids;
		dialog.current?.close();
	}

	function choose(asset: Asset): void {
		if (!multiple) return close([asset.assetId]);
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(asset.assetId)) next.delete(asset.assetId);
			else next.add(asset.assetId);
			return next;
		});
	}

	function move(event: KeyboardEvent, inList = false): void {
		if (isImeComposing(event.nativeEvent) || !visible.length) return;
		const { key } = event;
		if (key === "ArrowDown" || key === "ArrowUp") {
			event.preventDefault();
			if (inList) setActiveIndex(Math.max(0, Math.min(visible.length - 1, index + (key === "ArrowDown" ? 1 : -1))));
			else list.current?.focus({ preventScroll: true });
		} else if (inList && (key === "Home" || key === "End")) {
			event.preventDefault();
			setActiveIndex(key === "Home" ? 0 : visible.length - 1);
		} else if (inList && key === " " && active) {
			event.preventDefault();
			choose(active);
		} else if (key === "Enter") {
			event.preventDefault();
			accept();
		}
	}

	return <dialog ref={dialog} className="library-file-search" aria-labelledby={heading}
		onKeyDown={(event) => event.stopPropagation()}
		onClose={(event) => {
			if (event.currentTarget.open) return;
			const ids = confirmed.current;
			confirmed.current = [];
			onClose(ids.flatMap((id) => {
				const asset = byId.get(id);
				return asset ? [asset] : [];
			}));
		}}>
		<h2 id={heading}>{title}</h2>
		<input type="text" role="searchbox" inputMode="search" autoFocus aria-label={t.fileSearch.search} aria-controls={listId}
			placeholder={t.fileSearch.placeholder} value={query}
			onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
			onKeyDown={(event) => move(event)} />
		<ul ref={list} id={listId} className="library-file-results thin-scroll" role="listbox"
			tabIndex={0} hidden={!visible.length} aria-label={t.fileSearch.results}
			aria-multiselectable={multiple || undefined} aria-activedescendant={active ? `${listId}-${index}` : undefined}
			onKeyDown={(event) => move(event, true)}>
			{visible.map((asset, row) => <li key={asset.assetId} id={`${listId}-${row}`} role="option" data-active={index === row}
				aria-selected={selected.has(asset.assetId)} onClick={() => { setActiveIndex(row); choose(asset); }}>
				<span className="library-file-name">{asset.filename}</span>
				{asset.relativePath !== asset.filename && <span className="library-file-path">{parentFolder(asset.relativePath)}</span>}
			</li>)}
		</ul>
		{!matches.length && <p className="library-file-message" role="status">{t.fileSearch.noResults}</p>}
		{matches.length > RESULT_LIMIT && <p className="library-file-message">{t.fileSearch.resultLimit(RESULT_LIMIT)}</p>}
		<footer>
			<button type="button" onClick={() => close([])}>{t.common.cancel}</button>
			<button type="button" className="library-file-confirm" disabled={!active && !selection.length} onClick={accept}>
				{selection.length ? `${t.fileSearch.confirm} (${selection.length})` : t.fileSearch.confirm}
			</button>
		</footer>
	</dialog>;
}
