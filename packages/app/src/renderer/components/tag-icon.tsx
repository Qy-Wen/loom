type TagIconProps = { size?: number; className?: string };

/** Tag directory icon. Individual tags use the lighter hash mark below. */
export function TagIcon({ size = 16, className }: TagIconProps): React.JSX.Element {
	return (
		<svg className={className} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M2.5 8.2 8 2.7h5.2V8l-5.6 5.4a1.2 1.2 0 0 1-1.7 0L2.5 9.6a1 1 0 0 1 0-1.4Z" />
			<circle cx="10.4" cy="5.2" r="0.8" fill="currentColor" />
		</svg>
	);
}

export function TagHashIcon({ size = 16, className }: TagIconProps): React.JSX.Element {
	return (
		<svg className={className} viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
			<path d="M6.5 2.5 4.5 13.5M11.5 2.5 9.5 13.5M3 6h11M2 10h11" transform="translate(.8 .8) scale(.9)" />
		</svg>
	);
}

export function TagActionIcon({ action }: { action: "add" | "remove" }): React.JSX.Element {
	return (
		<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
			<path d={action === "add" ? "M6 2v8M2 6h8" : "M3 3l6 6m0-6L3 9"} />
		</svg>
	);
}
