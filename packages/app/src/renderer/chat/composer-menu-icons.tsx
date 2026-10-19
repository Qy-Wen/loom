export function MenuCheck({ selected }: { selected: boolean }): React.JSX.Element {
	return <svg className="session-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ visibility: selected ? "visible" : "hidden" }}>
		<path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
	</svg>;
}

export function MenuChevron({ right = false }: { right?: boolean }): React.JSX.Element {
	return <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true" style={right ? { transform: "rotate(-90deg)" } : undefined}>
		<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
	</svg>;
}
