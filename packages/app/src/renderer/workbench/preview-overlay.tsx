import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale } from "../locale.tsx";

/** How long to wait for the window's full screen event before the next request goes out anyway. */
const FULLSCREEN_SETTLE_MS = 1500;

/**
 * A file preview drawn over the folder browser, inside the workbench so the side panels stay usable.
 * Escape, the scrim, and the close button dismiss it. The expand button takes the card to full screen.
 */
export function PreviewOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): React.JSX.Element {
	const { t } = useLocale();
	const card = useRef<HTMLDivElement>(null);
	const [fullscreen, setFullscreen] = useState(false);
	const close = useRef(onClose);
	close.current = onClose;

	// The page flips to full screen at once, but the window finishes its animation (macOS: about 0.6s) later. A request
	// made in between leaves the page's idea of full screen out of step with the window's, and every later exit hangs.
	// So a click during the change waits for the window's own event (or a timeout, where a platform sends none).
	const changing = useRef(false);
	const queued = useRef(false);
	const settle = useRef<number | undefined>(undefined);
	const toggle = useRef<() => void>(() => undefined);
	toggle.current = () => {
		const element = card.current;
		if (!element) return;
		if (changing.current) {
			queued.current = true;
			return;
		}
		changing.current = true;
		window.clearTimeout(settle.current);
		settle.current = window.setTimeout(() => settled.current(), FULLSCREEN_SETTLE_MS);
		const request = document.fullscreenElement === element ? document.exitFullscreen() : element.requestFullscreen();
		void request.catch(() => settled.current());
	};
	const settled = useRef<() => void>(() => undefined);
	settled.current = () => {
		window.clearTimeout(settle.current);
		changing.current = false;
		if (!queued.current) return;
		queued.current = false;
		toggle.current();
	};

	useEffect(() => window.loom.onFullscreenChanged(() => settled.current()), []);

	useEffect(() => {
		const sync = () => setFullscreen(document.fullscreenElement === card.current);
		document.addEventListener("fullscreenchange", sync);
		return () => {
			window.clearTimeout(settle.current);
			document.removeEventListener("fullscreenchange", sync);
			if (document.fullscreenElement === card.current) void document.exitFullscreen().catch(() => undefined);
		};
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			// Escape first closes an open find bar or a rename, which handle it themselves.
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
			if (card.current?.querySelector(".find-bar")) return;
			close.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		card.current?.focus({ preventScroll: true });
	}, []);

	const label = fullscreen ? t.browser.exitFullscreen : t.browser.fullscreen;
	return (
		<div className="preview-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div className="preview-overlay-card" ref={card} role="dialog" aria-label={t.browser.preview} tabIndex={-1}>
				<div className="preview-overlay-bar">
					<span className="preview-overlay-title" title={title}>{title}</span>
					<button
						type="button"
						title={label}
						aria-label={label}
						aria-pressed={fullscreen}
						onClick={() => toggle.current()}
					>
						<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
							<path
								fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
								d={fullscreen ? "M3.2 6.2h3v-3M12.8 6.2h-3v-3M9.8 12.8v-3h3M6.2 12.8v-3h-3" : "M6.2 3.2H3.2v3M9.8 3.2h3v3M12.8 9.8v3h-3M6.2 12.8h-3v-3"}
							/>
						</svg>
					</button>
					<button type="button" title={t.browser.closePreview} aria-label={t.browser.closePreview} onClick={onClose}>
						<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
							<path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="m4 4 8 8M12 4l-8 8" />
						</svg>
					</button>
				</div>
				<div className="preview-overlay-body">{children}</div>
			</div>
		</div>
	);
}
