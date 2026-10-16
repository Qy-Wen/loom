import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../locale.tsx";
import { SettingsSecretInput } from "./settings-secret-input.tsx";

/** Confirm persists the key; Cancel discards only this dialog's edits. */
export function SettingsApiKey({ label, value, placeholder, onConfirm }: {
	label: string;
	value: string;
	placeholder: string;
	onConfirm: (key: string) => Promise<boolean>;
}): React.JSX.Element {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const [input, setInput] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);

	function close(): void { if (saving) return; setOpen(false); setInput(""); setError(false); }
	async function confirm(): Promise<void> {
		if (saving) return;
		setSaving(true); setError(false);
		try {
			if (await onConfirm(input)) { setOpen(false); setInput(""); } else setError(true);
		} catch { setError(true); }
		finally { setSaving(false); }
	}

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault(); event.stopPropagation();
				if (!dialogRef.current?.querySelector("input")?.disabled) close();
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
			buttonRef.current?.focus({ preventScroll: true });
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
						<SettingsSecretInput
							label={label}
							value={input}
							disabled={saving}
							placeholder={placeholder}
							autoComplete="off"
							autoFocus
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void confirm(); }
							}}
						/>
						{error && <p className="settings-status-error" role="alert">{t.settings.apiKeySaveFailed}</p>}
						<div className="settings-actions settings-login-actions">
							<button type="button" disabled={saving} onClick={close}>{t.common.cancel}</button>
							<button className="primary-button" type="button" disabled={saving} onClick={() => void confirm()}>{t.settings.apiKeyConfirm}</button>
						</div>
					</div>
				</div>,
				document.body,
			)}
		</>
	);
}
