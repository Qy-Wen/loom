/** Some IMEs report the final composition key as Process even after compositionend. */
export function isImeComposing(event: KeyboardEvent): boolean {
	return event.isComposing || event.keyCode === 229;
}
