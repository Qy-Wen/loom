import { useEffect, useRef } from "react";

interface SuggestInputProps {
	value: string;
	open: boolean;
	suggestions: readonly string[];
	placeholder: string;
	autoFocus?: boolean;
	openOnFocus?: boolean;
	showLabel: string;
	hideLabel: string;
	labelFor?: (value: string) => string;
	onChange: (value: string) => void;
	onOpenChange: (open: boolean) => void;
}

export function SuggestInput({
	value,
	open,
	suggestions,
	placeholder,
	autoFocus,
	openOnFocus = true,
	showLabel,
	hideLabel,
	labelFor,
	onChange,
	onOpenChange,
}: SuggestInputProps): React.JSX.Element {
	const rootRef = useRef<HTMLDivElement>(null);
	const query = value.trim().toLowerCase();
	const matches = suggestions.filter((item) => {
		if (!query) return true;
		const label = labelFor?.(item) ?? item;
		return item.toLowerCase().includes(query) || label.toLowerCase().includes(query);
	});

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
				autoFocus={autoFocus}
				value={value}
				placeholder={placeholder}
				aria-expanded={open}
				onChange={(event) => {
					onChange(event.target.value);
					onOpenChange(true);
				}}
				onFocus={() => {
					if (openOnFocus && suggestions.length > 0) onOpenChange(true);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") onOpenChange(false);
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
								{labelFor?.(item) ?? item}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
