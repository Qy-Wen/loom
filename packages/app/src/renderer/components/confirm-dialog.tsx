import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../locale.tsx";

export interface ConfirmChoice {
	label: string;
	onSelect: () => void;
	primary?: boolean;
}

/** Modal with Cancel plus one or more choices. Esc and a click outside cancel. */
export function ChoiceDialog({ title, body, choices, onCancel }: {
	title: string;
	body: string;
	choices: readonly ConfirmChoice[];
	onCancel: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const dialogRef = useRef<HTMLDivElement>(null);
	const cancelRef = useRef(onCancel);
	cancelRef.current = onCancel;
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault(); event.stopPropagation();
				cancelRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button");
			if (!controls?.length) return;
			const first = controls[0]!, last = controls[controls.length - 1]!;
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		};
		// Consume Escape before any panel or page behind the dialog sees it.
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			previous?.focus({ preventScroll: true });
		};
	}, []);
	return createPortal(
		<div className="settings-login-overlay" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
			<div ref={dialogRef} className="settings-login-card" role="dialog" aria-modal="true" aria-label={title}>
				<h3>{title}</h3>
				<p>{body}</p>
				<div className="settings-actions settings-login-actions">
					<button type="button" onClick={onCancel}>{t.common.cancel}</button>
					{choices.map((choice) => (
						<button
							key={choice.label}
							type="button"
							className={choice.primary ? "primary-button" : undefined}
							onClick={choice.onSelect}
						>
							{choice.label}
						</button>
					))}
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** One yes/no question. */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: {
	title: string;
	body: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
}): React.JSX.Element {
	return <ChoiceDialog title={title} body={body} choices={[{ label: confirmLabel, onSelect: onConfirm, primary: true }]} onCancel={onCancel} />;
}
