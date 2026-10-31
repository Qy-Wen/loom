import { useEffect, useRef, useState } from "react";
import { useLocale } from "../locale.tsx";
import type { FileSort, FileSortDirection } from "./tree-nav.ts";

function NameSortIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<path d="M3.2 12.6 8 3.2l4.8 9.4M5.2 9.2h5.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function ModifiedSortIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
			<path d="M8 4.8V8.2l2.2 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

export function FileSortControl({
	sort,
	direction,
	onSort,
	onDirection,
}: {
	sort: FileSort;
	direction: FileSortDirection;
	onSort: (sort: FileSort) => void;
	onDirection: (direction: FileSortDirection) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement>(null);
	const directionLabel = direction === "asc" ? t.library.sortAscending : t.library.sortDescending;

	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			if (rootRef.current?.contains(event.target as Node)) return;
			setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", close);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<span className="file-sort" ref={rootRef}>
			<button
				type="button"
				className={open ? "active" : ""}
				aria-label={t.library.sortFiles}
				aria-haspopup="menu"
				aria-expanded={open}
				title={sort === "name" ? t.library.sortByName : t.library.sortByModified}
				onClick={() => setOpen((current) => !current)}
			>
				{sort === "name" ? <NameSortIcon /> : <ModifiedSortIcon />}
			</button>
			<button
				type="button"
				aria-label={directionLabel}
				title={directionLabel}
				onClick={() => {
					setOpen(false);
					onDirection(direction === "asc" ? "desc" : "asc");
				}}
			>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
					<path
						d={direction === "asc" ? "M8 3.2v9.6M5.2 6 8 3.2 10.8 6" : "M8 12.8V3.2M5.2 10 8 12.8 10.8 10"}
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open ? (
				<span className="file-sort-menu" role="menu" aria-label={t.library.sortFiles}>
					<button
						type="button"
						role="menuitemradio"
						aria-checked={sort === "name"}
						onClick={() => {
							onSort("name");
							setOpen(false);
						}}
					>
						{t.library.sortByName}
					</button>
					<button
						type="button"
						role="menuitemradio"
						aria-checked={sort === "modified"}
						onClick={() => {
							onSort("modified");
							setOpen(false);
						}}
					>
						{t.library.sortByModified}
					</button>
				</span>
			) : null}
		</span>
	);
}
