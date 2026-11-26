import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LoomSessionSummary as SessionSummary } from "@loom/agent";
import { useLocale } from "../locale.tsx";
import { useInlineRename } from "../components/use-inline-rename.ts";
import { isImeComposing } from "../components/ime-composition.ts";
import { SessionHistory } from "./session-history.tsx";
import { sessionTitle } from "./session-title.ts";

interface SessionBarProps {
	sessions: SessionSummary[];
	currentId: string | null;
	/** Whether the current session has no messages yet. */
	currentEmpty: boolean;
	busy: boolean;
	onCreate: () => void;
	onSelect: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onArchive: (id: string) => void;
	onUnarchive: (id: string) => void;
	onDelete: (id: string) => void;
	onRefresh: () => void;
	onFind?: () => void;
	findOpen: boolean;
}

export function SessionBar({
	sessions,
	currentId,
	currentEmpty,
	busy,
	onCreate,
	onSelect,
	onRename,
	onArchive,
	onUnarchive,
	onDelete,
	onRefresh,
	onFind,
	findOpen,
}: SessionBarProps): React.JSX.Element {
	const { t } = useLocale();
	const titleOf = (session: SessionSummary) => sessionTitle(session, t.sessions.untitled);
	const open = sessions.filter((session) => session.status === "open");
	const archived = sessions.filter((session) => session.status === "archived");
	// Closing the only session, while it is still empty, would just swap it for another empty one.
	const closable = !(open.length === 1 && open[0]!.id === currentId && currentEmpty);
	const tabsRef = useRef<HTMLDivElement>(null);
	const [rename, setRename] = useState<{ id: string; title: string; tab: HTMLButtonElement } | null>(null);
	const focusAfterRename = useRef<HTMLButtonElement | null>(null);

	useLayoutEffect(() => {
		if (rename) return;
		focusAfterRename.current?.focus({ preventScroll: true });
		focusAfterRename.current = null;
	}, [rename]);

	useEffect(() => {
		if (rename && !sessions.some((session) => session.id === rename.id && session.status === "open")) setRename(null);
	}, [rename, sessions]);

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
				const editing = rename?.id === session.id ? rename : null;
					const startRename = (tab: HTMLButtonElement) => setRename({ id: session.id, title, tab });
					return (
						<div
							key={session.id}
						className={`session-tab${selected ? " active" : ""}${editing ? " renaming" : ""}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={selected}
								aria-description={activity}
							aria-keyshortcuts="F2"
								aria-disabled={busy}
								data-tooltip={`${title} · ${activity}`}
								onClick={() => {
									// A selection in progress blocks another switch while the tab can still receive a double-click.
									if (!busy) onSelect(session.id);
							}}
								onDoubleClick={(event) => startRename(event.currentTarget)}
							onKeyDown={(event) => {
								if (event.key !== "F2" || isImeComposing(event.nativeEvent)) return;
								event.preventDefault();
									startRename(event.currentTarget);
							}}
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
							{editing && (
								<SessionRenameInput title={editing.title} onFinish={(value, returnFocus) => {
									if (returnFocus) focusAfterRename.current = editing.tab;
									setRename((current) => current === editing ? null : current);
									const next = value?.trim();
									if (next && next !== editing.title) onRename(session.id, next);
								}} />
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

function SessionRenameInput({ title, onFinish }: { title: string; onFinish: (value: string | null, returnFocus: boolean) => void }) {
	const { t } = useLocale();
	const returnFocus = useRef(false);
	const input = useInlineRename(title, true, (value) => onFinish(value, returnFocus.current), () => onFinish(null, returnFocus.current));
	return (
		<input
			{...input}
			className="session-tab-rename"
			aria-label={t.sessions.rename}
			onKeyDown={(event) => {
				if (isImeComposing(event.nativeEvent)) return;
				if (event.key === "Enter" || event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					returnFocus.current = true;
				}
				input.onKeyDown?.(event);
			}}
		/>
	);
}
