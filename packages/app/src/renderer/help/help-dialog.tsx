import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../locale.tsx";

/** User tips. The text lives in `help.sections` in shared/locale.ts; add a section there and it shows up here. */
export function HelpDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
	const { t } = useLocale();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault(); event.stopPropagation();
			closeRef.current();
		};
		// Consume Escape before any panel behind the dialog sees it.
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			previous?.focus({ preventScroll: true });
		};
	}, []);
	return createPortal(
		<div className="settings-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div ref={dialogRef} className="settings-dialog help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
				<div className="settings-header">
					<h2 id="help-title">{t.help.title}</h2>
					<button className="icon-button" type="button" onClick={onClose} aria-label={t.help.close}>×</button>
				</div>
				<div className="help-body">
					{t.help.sections.map((section) => (
						<section key={section.title} className="help-section">
							<h3>{section.title}</h3>
							{section.paragraphs.map((text) => <p key={text}>{text}</p>)}
						</section>
					))}
				</div>
			</div>
		</div>,
		document.body,
	);
}
