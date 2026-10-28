import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../locale.tsx";

/**
 * User tips: a topic list on the left and one topic on the right. The text lives in `help.groups` in
 * shared/locale.ts; add a section to a group there and it shows up in the list. A section's `id` is stable
 * across languages, so the selection survives a language change and other places can link to a topic.
 */
export function HelpDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
	const { t } = useLocale();
	const sections = t.help.groups.flatMap((group) => group.sections);
	const [selected, setSelected] = useState(sections[0]?.id);
	const section = sections.find((candidate) => candidate.id === selected) ?? sections[0];
	const bodyRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	// Closing needs the press and the release on the backdrop. Dragging a text selection out of the dialog
	// presses inside it and releases outside, and the browser then reports that click on the backdrop.
	const pressedBackdrop = useRef(false);
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
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
		<div
			className="settings-overlay"
			role="presentation"
			onPointerDown={(event) => { pressedBackdrop.current = event.target === event.currentTarget; }}
			onClick={(event) => {
				if (event.target === event.currentTarget && pressedBackdrop.current) onClose();
				pressedBackdrop.current = false;
			}}
		>
			<div ref={dialogRef} className="settings-dialog help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
				<div className="settings-header">
					<h2 id="help-title">{t.help.title}</h2>
					<button className="icon-button" type="button" onClick={onClose} aria-label={t.help.close}>×</button>
				</div>
				<div className="help-layout">
					<nav className="help-nav" aria-label={t.help.topics}>
						{t.help.groups.map((group) => (
							<div key={group.title} className="help-group">
								<div className="help-group-title" id={`help-group-${group.sections[0]?.id}`}>{group.title}</div>
								<div role="tablist" aria-orientation="vertical" aria-labelledby={`help-group-${group.sections[0]?.id}`}>
									{group.sections.map((item) => (
										<button
											key={item.id}
											type="button"
											role="tab"
											id={`help-tab-${item.id}`}
											aria-selected={item.id === section?.id}
											aria-controls="help-panel"
											tabIndex={item.id === section?.id ? 0 : -1}
											className={item.id === section?.id ? "is-active" : undefined}
											onClick={() => { setSelected(item.id); bodyRef.current?.scrollTo({ top: 0 }); }}
											onKeyDown={(event) => {
												if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
												event.preventDefault();
												const at = sections.findIndex((candidate) => candidate.id === item.id);
												const next = sections[(at + (event.key === "ArrowDown" ? 1 : sections.length - 1)) % sections.length];
												if (!next) return;
												setSelected(next.id); bodyRef.current?.scrollTo({ top: 0 });
												dialogRef.current?.querySelector<HTMLElement>(`#help-tab-${next.id}`)?.focus();
											}}
										>{item.title}</button>
									))}
								</div>
							</div>
						))}
					</nav>
					<div ref={bodyRef} className="help-body" id="help-panel" role="tabpanel" aria-labelledby={section ? `help-tab-${section.id}` : undefined}>
						{section && (
							<section className="help-section">
								<h3>{section.title}</h3>
								{section.paragraphs.map((text) => <p key={text}>{text}</p>)}
							</section>
						)}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
