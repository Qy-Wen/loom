import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { LoomSessionSummary } from "@loom/agent";
import { isImeComposing } from "../components/ime-composition.ts";
import { useLocale } from "../locale.tsx";

export function SessionHistory({ sessions, busy, titleOf, onOpen, onDelete }: {
	sessions: readonly LoomSessionSummary[];
	busy: boolean;
	titleOf: (session: LoomSessionSummary) => string;
	onOpen: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const { t } = useLocale();
	const panelId = useId();
	const wrapper = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const matches = open ? sessions.filter((session) => titleOf(session).toLowerCase().includes(needle)) : [];

	useLayoutEffect(() => {
		if (open) search.current?.focus({ preventScroll: true });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		function dismissOutside(event: PointerEvent) {
			if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false);
		}
		document.addEventListener("pointerdown", dismissOutside);
		return () => document.removeEventListener("pointerdown", dismissOutside);
	}, [open]);

	function close() {
		setOpen(false);
		trigger.current?.focus({ preventScroll: true });
	}

	function openSession(id: string) {
		close();
		onOpen(id);
	}

	return <div className="session-archived" ref={wrapper}>
		<button
			ref={trigger}
			type="button"
			disabled={busy}
			aria-expanded={open}
			aria-controls={open ? panelId : undefined}
			aria-label={t.sessions.archived}
			data-tooltip={t.sessions.archived}
			onClick={() => {
				setQuery("");
				setOpen(!open);
			}}
		>
			<svg className="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" />
			</svg>
		</button>
		{open && <section id={panelId} className="session-archived-menu" aria-label={t.sessions.archived} onKeyDown={(event) => {
			if (event.defaultPrevented || isImeComposing(event.nativeEvent)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		}}>
			<input
				ref={search}
				type="search"
				className="session-archived-search"
				aria-label={t.sessions.searchHistory}
				placeholder={t.sessions.searchHistory}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			{matches.length > 0 ? <ul className="session-archived-list">
				{matches.map((session) => {
					const title = titleOf(session);
					return <li key={session.id} className="session-archived-row">
						<button
							type="button"
							className="session-archived-open"
							disabled={busy}
							data-tooltip={title}
							onClick={() => openSession(session.id)}
						>{title}</button>
						<button
							type="button"
							className="session-tab-close"
							disabled={busy}
							aria-label={t.sessions.delete(title)}
							onClick={() => onDelete(session.id)}
						>×</button>
					</li>;
				})}
			</ul> : <div className="session-archived-empty" role="status">{t.sessions.noMatchingHistory}</div>}
		</section>}
	</div>;
}
