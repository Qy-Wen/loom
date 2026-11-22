import type { MouseEventHandler } from "react";

export function DocumentModeButton({ previewing, label, disabled, onToggle, onMouseDown }: {
	previewing: boolean;
	label: string;
	disabled?: boolean;
	onToggle: () => void;
	onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element {
	return (
		<button type="button" className="document-mode-toggle" aria-label={label} data-tooltip={label}
			aria-pressed={previewing} disabled={disabled} onMouseDown={onMouseDown} onClick={onToggle}>
			<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
				{previewing ? <path d="m15 4 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /> : <>
					<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
					<circle cx="12" cy="12" r="3" />
				</>}
			</svg>
		</button>
	);
}
