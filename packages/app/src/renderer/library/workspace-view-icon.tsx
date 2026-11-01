/** Matching outline icons for the three workspace views. */
export function WorkspaceViewIcon({ view }: { view: "library" | "table" | "graph" }): React.JSX.Element {
	return (
		<svg
			className="workspace-view-icon"
			viewBox="0 0 16 16"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{view === "library" && (
				<>
					<rect x="2" y="2.5" width="12" height="3" rx="0.75" />
					<path d="M3 5.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7M6.5 8.5h3" />
				</>
			)}
			{view === "table" && (
				<>
					<rect x="2" y="2.5" width="12" height="11" rx="1" />
					<path d="M2 6h12M2 9.5h12M6 6v7.5" />
				</>
			)}
			{view === "graph" && (
				<>
					<path d="m4 6 2.8 4.3M5 4.5l6 1M9.3 10.5l2.4-3.3" />
					<circle cx="3.5" cy="4.5" r="1.75" />
					<circle cx="12.5" cy="5.5" r="1.75" />
					<circle cx="8" cy="12" r="1.75" />
				</>
			)}
		</svg>
	);
}
