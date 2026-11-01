import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "../../locale.tsx";
import {
	applyFindHighlights,
	clearFindHighlights,
	collectTextRanges,
	scrollRangeIntoView,
} from "./find-in-view.ts";

export function FindBar({
	rootRef,
	assetId,
	documentKey,
}: {
	rootRef: React.RefObject<HTMLElement | null>;
	assetId: string;
	documentKey: string;
}): React.JSX.Element | null {
	const { t } = useLocale();
	const inputRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [matchCount, setMatchCount] = useState(0);
	const rangesRef = useRef<Range[]>([]);

	useEffect(() => {
		setOpen(false);
		setQuery("");
		setActiveIndex(0);
		clearFindHighlights();
	}, [assetId]);

	useEffect(() => {
		function step(direction: 1 | -1): void {
			const total = rangesRef.current.length;
			if (total === 0) return;
			setActiveIndex((current) => (current + direction + total) % total);
		}

		function onKeyDown(event: KeyboardEvent): void {
			const target = event.target;
			const inFind = target === inputRef.current;
			if (target instanceof HTMLTextAreaElement) return;
			if (target instanceof HTMLInputElement && !inFind) return;

			const mod = event.metaKey || event.ctrlKey;
			if (mod && event.key.toLowerCase() === "f") {
				event.preventDefault();
				setOpen(true);
				requestAnimationFrame(() => {
					inputRef.current?.focus();
					inputRef.current?.select();
				});
				return;
			}
			if (!open) return;
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(false);
				clearFindHighlights();
				return;
			}
			if (event.key === "Enter" && inFind) {
				event.preventDefault();
				step(event.shiftKey ? -1 : 1);
				return;
			}
			if (event.key === "F3") {
				event.preventDefault();
				step(event.shiftKey ? -1 : 1);
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open]);

	useLayoutEffect(() => {
		if (!open) {
			rangesRef.current = [];
			setMatchCount(0);
			clearFindHighlights();
			return;
		}
		const root = rootRef.current;
		const ranges = root ? collectTextRanges(root, query) : [];
		rangesRef.current = ranges;
		setMatchCount(ranges.length);
		const nextIndex = ranges.length === 0 ? 0 : Math.min(activeIndex, ranges.length - 1);
		if (nextIndex !== activeIndex) {
			setActiveIndex(nextIndex);
			return;
		}
		applyFindHighlights(ranges, nextIndex);
		scrollRangeIntoView(ranges[nextIndex]);
		return () => clearFindHighlights();
	}, [open, query, activeIndex, documentKey, rootRef]);

	function move(direction: 1 | -1): void {
		const total = rangesRef.current.length;
		if (total === 0) return;
		setActiveIndex((current) => (current + direction + total) % total);
	}

	if (!open) return null;

	return (
		<div className="find-bar">
			<input
				ref={inputRef}
				aria-label={t.find.label}
				placeholder={t.find.placeholder}
				value={query}
				onChange={(event) => {
					setQuery(event.target.value);
					setActiveIndex(0);
				}}
			/>
			<span className="find-bar-count">
				{query.trim() ? `${matchCount === 0 ? 0 : activeIndex + 1}/${matchCount}` : ""}
			</span>
			<button type="button" aria-label={t.find.previous} onClick={() => move(-1)}>↑</button>
			<button type="button" aria-label={t.find.next} onClick={() => move(1)}>↓</button>
			<button
				type="button"
				aria-label={t.find.close}
				onClick={() => {
					setOpen(false);
					clearFindHighlights();
				}}
			>×</button>
		</div>
	);
}
