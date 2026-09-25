import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@loom/core";

interface SessionBarProps {
	sessions: SessionSummary[];
	currentId: string | null;
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
	busy,
	onCreate,
	onSelect,
	onArchive,
	onUnarchive,
	onDelete,
	onRefresh,
}: SessionBarProps): React.JSX.Element {
	const open = sessions.filter((session) => session.status === "open");
	const archived = sessions.filter((session) => session.status === "archived");
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

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
			<div className="session-tabs" role="tablist" aria-label="Sessions">
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
							<button
								type="button"
								className="session-tab-close"
								disabled={busy}
								aria-label={`Close ${session.title}`}
								onClick={(event) => {
									event.stopPropagation();
									onArchive(session.id);
								}}
							>
								×
							</button>
						</div>
					);
				})}
			</div>
			<button
				type="button"
				className="session-tab-new"
				disabled={busy}
				aria-label="New session"
				title="New session"
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
						Archived
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
										aria-label={`Delete ${session.title}`}
										onClick={() => {
											setMenuOpen(false);
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
