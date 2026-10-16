import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../locale.tsx";

/** The dialog edits the settings draft only; the outer Settings Save persists it. */
export function SettingsApiKey({ label, value, placeholder, onConfirm }: {
	label: string;
	value: string;
	placeholder: string;
	onConfirm: (key: string) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const [input, setInput] = useState("");
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);

	function close(): void { setOpen(false); setInput(""); }
	function confirm(): void { onConfirm(input); close(); }

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault(); event.stopPropagation(); close();
				return;
			}
			if (event.key !== "Tab") return;
			const controls = dialogRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])');
			if (!controls?.length) return;
			const first = controls[0]!, last = controls[controls.length - 1]!;
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		};
		// Consume Escape before the Settings page's close handler.
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			buttonRef.current?.focus();
		};
	}, [open]);

	return (
		<>
			<button ref={buttonRef} type="button" aria-label={label} onClick={() => { setInput(value); setOpen(true); }}>
				{t.settings.apiKey}
			</button>
			{open && createPortal(
				<div className="settings-login-overlay" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
					event.stopPropagation();
					if (event.target === event.currentTarget) close();
				}}>
					<div ref={dialogRef} className="settings-login-card" role="dialog" aria-modal="true" aria-label={label}>
						<h3>{label}</h3>
						<p>{t.settings.apiKeyDialogNote}</p>
						<input
							type="password"
							value={input}
							placeholder={placeholder}
							aria-label={label}
							autoComplete="off"
							autoFocus
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); confirm(); }
							}}
						/>
						<div className="settings-actions">
							<button type="button" onClick={close}>{t.common.cancel}</button>
							<button className="primary-button" type="button" onClick={confirm}>{t.settings.apiKeyConfirm}</button>
						</div>
					</div>
				</div>,
				document.body,
			)}
		</>
	);
}
