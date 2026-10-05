/** Standing instructions the user wrote. Empty text adds nothing. */
export function systemPromptWithInstructions(base: string, instructions: string): string {
	const text = instructions.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
	if (!text) return base;
	return (
		`${base}\n\nUser instructions are shown below. Follow them. ` +
		`They override default behavior when they conflict.\n\n${text}`
	);
}
