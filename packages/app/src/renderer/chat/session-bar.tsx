import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import type { LoomSessionSummary as SessionSummary } from "@loom/agent";
import { useLocale } from "../locale.tsx";
import { useInlineRename } from "../components/use-inline-rename.ts";
import { isImeComposing } from "../components/ime-composition.ts";
import { moveTabBefore } from "../components/tab-order.ts";
import { writeWorkspacePreference } from "../library/workspace-storage.ts";
import { SessionHistory } from "./session-history.tsx";
import { orderedOpenSessions, readSessionTabOrder } from "./session-tab-order.ts";
import { sessionTitle } from "./session-title.ts";

const SESSION_TAB_DRAG = "application/x-loom-session-tab";
type TabDrag = { id: string; button: HTMLButtonElement; beforeId?: string | null };

interface SessionBarProps {
	libraryRoot: string;
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
	libraryRoot,
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
	const [order, setOrder] = useState(() => readSessionTabOrder(libraryRoot));
	const open = orderedOpenSessions(sessions, order);
	const archived = sessions.filter((session) => session.status === "archived");
	// Closing the only session, while it is still empty, would just swap it for another empty one.
	const closable = !(open.length === 1 && open[0]!.id === currentId && currentEmpty);
	const tabsRef = useRef<HTMLDivElement>(null);
	const [rename, setRename] = useState<{ id: string; title: string; tab: HTMLButtonElement } | null>(null);
	const focusAfterRename = useRef<HTMLButtonElement | null>(null);
	const [drag, setDrag] = useState<TabDrag | null>(null);
	const draggedIndex = drag ? open.findIndex((session) => session.id === drag.id) : -1;
	const dropMarker = draggedIndex >= 0 && drag?.beforeId !== drag?.id && drag?.beforeId !== (open[draggedIndex + 1]?.id ?? null)
		? drag?.beforeId : undefined;
	const statusRef = useRef<HTMLSpanElement>(null);
	const movedTab = useRef<{ button: HTMLButtonElement; focused: boolean; announcement: string } | null>(null);

	useLayoutEffect(() => {
		const move = movedTab.current;
		if (!move) return;
		movedTab.current = null;
		move.button.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
		if (move.focused) move.button.focus({ preventScroll: true });
		const status = statusRef.current;
		if (!status) return;
		status.textContent = "";
		const announce = window.setTimeout(() => { status.textContent = move.announcement; }, 300);
		return () => window.clearTimeout(announce);
	}, [order]);

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

	function moveTab(id: string, beforeId: string | null, button: HTMLButtonElement): void {
		const ids = open.map((session) => session.id);
		const next = moveTabBefore(ids, id, beforeId);
		if (next === ids) return;
		const session = open[ids.indexOf(id)]!;
		movedTab.current = {
			button,
			focused: button === document.activeElement,
			announcement: t.sessions.reordered(titleOf(session), next.indexOf(id) + 1, next.length),
		};
		setOrder(next);
		writeWorkspacePreference(libraryRoot, "sessionTabOrder", next);
	}

	function dropBefore(event: DragEvent<HTMLDivElement>): string | null {
		const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-session-tab]") : null;
		if (!target) return null;
		const bounds = target.getBoundingClientRect();
		const before = event.clientX < bounds.left + bounds.width / 2 ? target : target.nextElementSibling;
		return before?.getAttribute("data-session-tab") ?? null;
	}

	return (
		<div className="session-bar" onPointerEnter={onRefresh}>
			<div
				className="session-tabs"
				ref={tabsRef}
				role="tablist"
				aria-label={t.sessions.label}
				onDragOver={(event) => {
					if (draggedIndex < 0 || !event.dataTransfer.types.includes(SESSION_TAB_DRAG)) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					const beforeId = dropBefore(event);
					setDrag((current) => current && current.beforeId !== beforeId ? { ...current, beforeId } : current);
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
						setDrag((current) => current && current.beforeId !== undefined ? { id: current.id, button: current.button } : current);
					}
				}}
				onDrop={(event) => {
					if (!drag || !event.dataTransfer.types.includes(SESSION_TAB_DRAG)) return;
					event.preventDefault();
					if (event.dataTransfer.getData(SESSION_TAB_DRAG) === drag.id) moveTab(drag.id, dropBefore(event), drag.button);
					setDrag(null);
				}}
			>
				{open.map((session, index) => {
					const selected = session.id === currentId;
					const title = titleOf(session);
					const activity = session.busy ? t.sessions.busy : t.sessions.idle;
				const editing = rename?.id === session.id ? rename : null;
					const startRename = (tab: HTMLButtonElement) => setRename({ id: session.id, title, tab });
					const marker = dropMarker === session.id ? " drop-before" : dropMarker === null && index === open.length - 1 ? " drop-after" : "";
					return (
						<div
							key={session.id}
							className={`session-tab${selected ? " active" : ""}${editing ? " renaming" : ""}${index === draggedIndex ? " dragging" : ""}${marker}`}
							data-session-tab={session.id}
						>
							<button
								type="button"
								role="tab"
								aria-selected={selected}
								aria-description={activity}
								aria-keyshortcuts="F2 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
								aria-disabled={busy}
								data-tooltip={`${title} · ${activity}`}
								draggable={!busy && open.length > 1}
								onDragStart={(event) => {
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData(SESSION_TAB_DRAG, session.id);
									setDrag({ id: session.id, button: event.currentTarget });
								}}
								onDragEnd={() => setDrag(null)}
								onClick={() => {
									// A selection in progress blocks another switch while the tab can still receive a double-click.
									if (!busy) onSelect(session.id);
							}}
								onDoubleClick={(event) => startRename(event.currentTarget)}
							onKeyDown={(event) => {
									if (isImeComposing(event.nativeEvent)) return;
									if (event.key === "F2") {
										event.preventDefault();
										startRename(event.currentTarget);
										return;
									}
									if (busy || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
									if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
									event.preventDefault();
									if (event.key === "ArrowLeft" && index > 0) moveTab(session.id, open[index - 1]!.id, event.currentTarget);
									if (event.key === "ArrowRight" && index < open.length - 1) moveTab(session.id, open[index + 2]?.id ?? null, event.currentTarget);
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
			<span className="session-tab-order-status" role="status" ref={statusRef} />
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
