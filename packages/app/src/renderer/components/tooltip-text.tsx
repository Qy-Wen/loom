/** Text hints share the window tooltip provider with buttons and other controls. */
export function TooltipText({ text, tooltip }: { text: string; tooltip?: string }): React.JSX.Element {
	return <span tabIndex={tooltip ? 0 : undefined} data-tooltip={tooltip}>{text}</span>;
}
