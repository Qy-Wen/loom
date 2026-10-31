import { useEffect, useRef } from "react";

interface SuggestInputProps {
	value: string;
	open: boolean;
	suggestions: readonly string[];
	placeholder: string;
	autoFocus?: boolean;
	showLabel: string;
	hideLabel: string;
	onChange: (value: string) => void;
	onOpenChange: (open: boolean) => void;
}

export function SuggestInput({
	value,
	open,
	suggestions,
	placeholder,
	autoFocus,
	showLabel,
	hideLabel,
	onChange,
	onOpenChange,
}: SuggestInputProps): React.JSX.Element {
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const autoFocusing = useRef(false);
	const query = value.trim().toLowerCase();
	const matches = suggestions.filter((item) => !query || item.toLowerCase().includes(query));

	useEffect(() => {
		if (!autoFocus) return;
		// Focus new forms without opening suggestions until the user interacts.
		autoFocusing.current = true;
		try { inputRef.current?.focus(); }
		finally { autoFocusing.current = false; }
	}, [autoFocus]);

	function showSuggestions(): void {
		if (suggestions.length > 0) onOpenChange(true);
	}

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent): void {
			if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
		}
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [open, onOpenChange]);

	return (
		<div className="suggest" ref={rootRef}>
			<input
				ref={inputRef}
				value={value}
				placeholder={placeholder}
				aria-expanded={open}
				onChange={(event) => {
					onChange(event.target.value);
					showSuggestions();
				}}
				onClick={showSuggestions}
				onFocus={() => {
					if (!autoFocusing.current) showSuggestions();
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" && suggestions.length > 0) {
						event.preventDefault();
						showSuggestions();
						return;
					}
					if (event.key !== "Escape" || !open) return;
					event.stopPropagation();
					onOpenChange(false);
				}}
			/>
			{suggestions.length > 0 && (
				<button
					type="button"
					className="suggest-toggle"
					aria-label={open ? hideLabel : showLabel}
					aria-expanded={open}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => onOpenChange(!open)}
				/>
			)}
			{open && matches.length > 0 && (
				<ul className="suggest-list" role="listbox">
					{matches.map((item) => (
						<li key={item}>
							<button
								type="button"
								role="option"
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => {
									onChange(item);
									onOpenChange(false);
								}}
							>
								{item}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
