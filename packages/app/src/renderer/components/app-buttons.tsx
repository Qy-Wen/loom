import { useLocale } from "../locale.tsx";

export function FileHistoryButtons({ mac, canBack, canForward, move }: {
	mac: boolean;
	canBack: boolean;
	canForward: boolean;
	move(direction: -1 | 1): void;
}): React.JSX.Element {
	const { t } = useLocale();
	return <>
		<button className="library-collapse" type="button" aria-label={t.app.back} aria-keyshortcuts={mac ? "Meta+Alt+ArrowLeft" : "Alt+ArrowLeft"}
			data-tooltip={`${t.app.back} · ${mac ? "⌘⌥←" : "Alt+←"}`} disabled={!canBack} onClick={() => move(-1)}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
				<path d="M12.5 8h-9m4-4-4 4 4 4" />
			</svg>
		</button>
		<button className="library-collapse" type="button" aria-label={t.app.forward} aria-keyshortcuts={mac ? "Meta+Alt+ArrowRight" : "Alt+ArrowRight"}
			data-tooltip={`${t.app.forward} · ${mac ? "⌘⌥→" : "Alt+→"}`} disabled={!canForward} onClick={() => move(1)}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
				<path d="M3.5 8h9m-4-4 4 4-4 4" />
			</svg>
		</button>
	</>;
}

export function SettingsButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.common.settings} data-tooltip={t.common.settings} onClick={onOpen}>
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</button>
	);
}

export function HelpButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.help.title} data-tooltip={t.help.title} onClick={onOpen}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
				<path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				<circle cx="8" cy="11.5" r=".85" fill="currentColor" />
			</svg>
		</button>
	);
}

export function TracesButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.library.traces} data-tooltip={t.library.traces} onClick={onOpen}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<path d="M2 12.5h12M3.5 10.5 6.2 7l2.2 2.2 3.6-4.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</button>
	);
}

export function LibraryOpenButton({ opening, onOpen }: { opening: boolean; onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.common.open} data-tooltip={t.common.open} onClick={onOpen} disabled={opening}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M1.8 6.2 3.2 3.6h3.4l1.1 1.3h5.5v1.3" />
				<path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M1.8 6.4h12.4l-1.3 6.1H3.1L1.8 6.4z" />
			</svg>
		</button>
	);
}

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }): React.JSX.Element {
	const { t } = useLocale();
	const label = collapsed ? t.library.expandSidebar : t.library.collapseSidebar;
	return (
		<button className="library-collapse sidebar-toggle" type="button" aria-label={label} aria-expanded={!collapsed}
			aria-controls="library-sidebar" data-tooltip={label} onClick={onToggle}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				{collapsed && <path className="sidebar-toggle-panel" d="M5.7 2.8H3.8a1.6 1.6 0 0 0-1.6 1.6v7.2a1.6 1.6 0 0 0 1.6 1.6h1.9Z" />}
				<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
				<path d="M5.7 2.8v10.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
			</svg>
		</button>
	);
}
