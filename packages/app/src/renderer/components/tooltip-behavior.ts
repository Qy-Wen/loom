import { useEffect } from "react";

/** Short enough to feel immediate, but lets the pointer enter an interactive error tip. */
export const TOOLTIP_LEAVE_DELAY_MS = 80;

const BUTTON_TIPS = [
	".window-bar button[aria-label]",
	".library-view-controls button[aria-label]",
	".panel-collapse[aria-label]",
	".browser-icon-size button[aria-label]",
].join(", ");

/** A clicked CSS tooltip stays dismissed until the next hover or keyboard focus. */
export function useTooltipDismissal(): void {
	useEffect(() => {
		const anchor = (event: Event): Element | null => event.target instanceof Element ? event.target.closest(BUTTON_TIPS) : null;
		const dismiss = (event: MouseEvent) => anchor(event)?.setAttribute("data-tooltip-dismissed", "");
		const reset = (event: PointerEvent | FocusEvent) => {
			const button = anchor(event);
			if (!button || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return;
			button.removeAttribute("data-tooltip-dismissed");
		};
		document.addEventListener("click", dismiss, true);
		document.addEventListener("pointerover", reset, true);
		document.addEventListener("focusin", reset, true);
		return () => {
			document.removeEventListener("click", dismiss, true);
			document.removeEventListener("pointerover", reset, true);
			document.removeEventListener("focusin", reset, true);
		};
	}, []);
}
