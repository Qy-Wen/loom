import { useEffect, useRef } from "react";
import type { LoomSessionSummary as SessionSummary } from "@loom/agent";
import { useLocale } from "../locale.tsx";
import { SessionHistory } from "./session-history.tsx";

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
	onFind?: () => void;
	findOpen: boolean;
}

/** The main process stores this exact string for unnamed sessions (DEFAULT_SESSION_TITLE in @loom/agent). */
const DEFAULT_TITLE = "New session";

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
	onFind,
	findOpen,
}: SessionBarProps): React.JSX.Element {
	const { t } = useLocale();
	const titleOf = (session: SessionSummary) => session.title === DEFAULT_TITLE ? t.sessions.untitled : session.title;
	const open = sessions.filter((session) => session.status === "open");
	const archived = sessions.filter((session) => session.status === "archived");
	// Closing the only session, while it is still empty, would just swap it for another empty one.
	const closable = !(open.length === 1 && open[0]!.id === currentId && currentEmpty);
	const tabsRef = useRef<HTMLDivElement>(null);

	// With many tabs the strip scrolls, so keep the current one in view.
	useEffect(() => {
		tabsRef.current?.querySelector(".session-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [currentId, open.length]);

	return (
		<div className="session-bar" onPointerEnter={onRefresh}>
			<div className="session-tabs" ref={tabsRef} role="tablist" aria-label={t.sessions.label}>
				{open.map((session) => {
					const selected = session.id === currentId;
					const title = titleOf(session);
					const activity = session.busy ? t.sessions.busy : t.sessions.idle;
					return (
						<div
							key={session.id}
							className={`session-tab${selected ? " active" : ""}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={selected}
								aria-description={activity}
								disabled={busy}
								data-tooltip={`${title} · ${activity}`}
								onClick={() => onSelect(session.id)}
							>
								{session.busy ? <span className="session-tab-status session-tab-spinner" aria-hidden="true" /> : (
									<svg className="session-tab-status" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
										<path d="M3 2h6a2 2 0 0 1 2 2v2.5a2 2 0 0 1-2 2H6L3.5 11V8.5H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
									</svg>
								)}
								<span className="session-tab-title">{title}</span>
							</button>
							{closable && (
								<button
									type="button"
									className="session-tab-close"
									disabled={busy}
									aria-label={t.sessions.close(title)}
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
				data-tooltip={t.sessions.new}
				onClick={onCreate}
			>
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
					<path d="M12 4.25v15.5M4.25 12h15.5" />
				</svg>
			</button>
			{onFind && <button
				type="button"
				className="session-tab-find"
				aria-label={t.chat.find}
				aria-expanded={findOpen}
				data-tooltip={t.chat.find}
				onClick={onFind}
			>
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15 15 4 4" /></svg>
			</button>}
			{archived.length > 0 && <SessionHistory sessions={archived} busy={busy} titleOf={titleOf} onOpen={onUnarchive} onDelete={onDelete} />}
		</div>
	);
}
