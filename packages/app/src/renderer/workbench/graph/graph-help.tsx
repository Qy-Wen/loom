import { useEffect, useId, useRef, useState } from "react";
import { uiPlatform } from "../../../shared/locale.ts";
import { useLocale } from "../../locale.tsx";

/** Local canvas instructions, separate from graph gestures and relation editing. */
export function GraphHelp(): React.JSX.Element {
	const { t } = useLocale();
	const help = t.graph.help;
	const platform = uiPlatform(navigator.userAgent);
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const panelId = useId();
	const titleId = useId();

	useEffect(() => {
		if (!open) return;
		panelRef.current?.focus();
		const onPointer = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			buttonRef.current?.focus();
		};
		window.addEventListener("pointerdown", onPointer);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("pointerdown", onPointer);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	const instructions = [
		[help.move, help.moveHint],
		[help.link, help.linkHint],
		[help.pan, help.panHint(platform)],
		[help.zoom, help.zoomHint(platform)],
		[help.box, help.boxHint],
		[help.add, help.addHint(platform)],
		[help.clear, help.clearHint],
		[help.remove, help.removeHint(platform)],
	];

	return (
		<div
			className="graph-help"
			ref={rootRef}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
			}}
		>
			<button
				ref={buttonRef}
				type="button"
				className="graph-help-button"
				aria-label={help.title}
				title={help.title}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen((current) => !current)}
			>
				<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
					<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
					<path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
					<circle cx="8" cy="11.5" r=".7" fill="currentColor" />
				</svg>
			</button>
			{open && (
				<div
					ref={panelRef}
					id={panelId}
					className="graph-help-popover"
					role="dialog"
					aria-labelledby={titleId}
					tabIndex={-1}
				>
					<div className="graph-help-header">
						<h2 id={titleId}>{help.title}</h2>
						<button
							type="button"
							className="graph-help-button"
							aria-label={help.close}
							onClick={() => {
								setOpen(false);
								buttonRef.current?.focus();
							}}
						>
							<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
								<path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
							</svg>
						</button>
					</div>
					<dl className="graph-help-instructions">
						{instructions.map(([label, hint]) => (
							<div key={label}>
								<dt>{label}</dt>
								<dd>{hint}</dd>
							</div>
						))}
					</dl>
				</div>
			)}
		</div>
	);
}
