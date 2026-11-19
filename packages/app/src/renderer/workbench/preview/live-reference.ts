import { ANCHOR_ATTRIBUTE, ASSET_LINK_ATTRIBUTE, BROKEN_REFERENCE_CLASS } from "./markdown.ts";

export const liveReferenceSelectors = [ASSET_LINK_ATTRIBUTE, ANCHOR_ATTRIBUTE]
	.map((attribute) => `[${attribute}]:not(.cm-live-broken):not(.${BROKEN_REFERENCE_CLASS})`);
const referenceSelector = liveReferenceSelectors.join(", ");

function findReference(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>(referenceSelector) : null;
}

/** Keep the start of a possible click so releasing a drag over a reference never follows it. */
export function pressedReference(event: MouseEvent): ((release: MouseEvent) => HTMLElement | null) | undefined {
	if (event.button !== 0 || event.altKey || event.shiftKey) return;
	const reference = findReference(event.target);
	if (!reference) return;
	const { clientX, clientY } = event;
	return (release) => {
		if (release.button !== 0 || release.altKey || release.shiftKey || findReference(release.target) !== reference) return null;
		return Math.hypot(release.clientX - clientX, release.clientY - clientY) <= 4 ? reference : null;
	};
}
