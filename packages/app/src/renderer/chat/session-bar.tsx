import { useEffect, useRef, useState } from "react";
import type { LoomSessionSummary as SessionSummary } from "@loom/agent";
import { useLocale } from "../locale.tsx";

interface SessionBarProps {
	sessions: SessionSummary[];
	currentId: string | null;
	/** Whether the current session has no messages yet. */
	currentEmpty: boolean;
	busy: boolean;
	onCreate: () => void;
	onSelect: (id: string) => void;
	onArchive: (id: string) => void;
	onUnarchive: (id: string) => void;
	onDelete: (id: string) => void;
	onRefresh: () => void;
}

export function SessionBar({
	sessions,
	currentId,
	currentEmpty,
	busy,
	onCreate,
	onSelect,
	onArchive,
	onUnarchive,
	onDelete,
	onRefresh,
}: SessionBarProps): React.JSX.Element {
	const { t } = useLocale();
	const open = sessions.filter((session) => session.status === "open");
	const archived = sessions.filter((session) => session.status === "archived");
	// Closing the only session, while it is still empty, would just swap it for another empty one.
	const closable = !(open.length === 1 && open[0]!.id === currentId && currentEmpty);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const tabsRef = useRef<HTMLDivElement>(null);

	// With many tabs the strip scrolls, so keep the current one in view.
	useEffect(() => {
		tabsRef.current?.querySelector(".session-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [currentId, open.length]);

	useEffect(() => {
		if (!menuOpen) return;
		function onPointerDown(event: PointerEvent): void {
			if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [menuOpen]);

	return (
		<div className="session-bar" onPointerEnter={onRefresh}>
			<div className="session-tabs" ref={tabsRef} role="tablist" aria-label={t.sessions.label}>
				{open.map((session) => {
					const selected = session.id === currentId;
					return (
						<div
							key={session.id}
							className={`session-tab${selected ? " active" : ""}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={selected}
								disabled={busy}
								title={session.title}
								onClick={() => onSelect(session.id)}
							>
								{session.title}
							</button>
							{closable && (
								<button
									type="button"
									className="session-tab-close"
									disabled={busy}
									aria-label={t.sessions.close(session.title)}
									onClick={(event) => {
										event.stopPropagation();
										onArchive(session.id);
									}}
								>
									×
								</button>
							)}
						</div>
					);
				})}
			</div>
			<button
				type="button"
				className="session-tab-new"
				disabled={busy}
				aria-label={t.sessions.new}
				title={t.sessions.new}
				onClick={onCreate}
			>
				+
			</button>
			{archived.length > 0 && (
				<div className="session-archived" ref={menuRef}>
					<button
						type="button"
						className={menuOpen ? "active" : ""}
						disabled={busy}
						aria-expanded={menuOpen}
						aria-haspopup="menu"
						onClick={() => setMenuOpen((openMenu) => !openMenu)}
					>
						{t.sessions.archived}
					</button>
					{menuOpen && (
						<div className="session-archived-menu" role="menu">
							{archived.map((session) => (
								<div key={session.id} className="session-archived-row" role="none">
									<button
										type="button"
										role="menuitem"
										disabled={busy}
										title={session.title}
										onClick={() => {
											setMenuOpen(false);
											onUnarchive(session.id);
										}}
									>
										{session.title}
									</button>
									<button
										type="button"
										className="session-tab-close"
										disabled={busy}
										aria-label={t.sessions.delete(session.title)}
										onClick={() => {
											onDelete(session.id);
										}}
									>
										×
									</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
