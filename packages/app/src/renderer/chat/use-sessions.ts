import { useCallback, useEffect, useRef, useState } from "react";
import type { LoomSessionRecord, LoomSessionSummary } from "@loom/agent";

/** Own session selection and committed history. Live output never writes into this state. */
export function useSessions(libraryRoot: string | null, deleteConfirm: string) {
	const [sessions, setSessions] = useState<LoomSessionSummary[]>([]);
	const [record, setRecord] = useState<LoomSessionRecord | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = useRef(record);
	const library = useRef(libraryRoot);
	library.current = libraryRoot;
	const recordLibrary = useRef(libraryRoot);
	const generation = useRef(0);
	const refreshing = useRef(false);
	const refreshPending = useRef(false);

	const activateRecord = useCallback((next: LoomSessionRecord) => {
		if (library.current !== libraryRoot) return;
		generation.current++;
		recordLibrary.current = libraryRoot;
		current.current = next;
		setRecord(next);
	}, [libraryRoot]);

	const refreshSessions = useCallback(async () => {
		const list = await window.loom.listSessions();
		if (library.current === libraryRoot) setSessions(list);
		return list;
	}, [libraryRoot]);

	const refreshCurrent = useCallback(async (): Promise<void> => {
		refreshPending.current = true;
		if (refreshing.current) return;
		refreshing.current = true;
		let version = generation.current;
		try {
			while (refreshPending.current) {
				refreshPending.current = false;
				const previous = current.current;
				if (!previous) continue;
				version = generation.current;
				const tail = previous.messages.at(-1)?.id;
				const next = await window.loom.getSession(previous.id, typeof tail === "string" ? tail : undefined);
				if (version !== generation.current) continue;
				const messages = tail ? next.messages.length ? [...previous.messages, ...next.messages] : previous.messages : next.messages;
				const updated = { ...next, messages };
				current.current = updated;
				setRecord(updated);
			}
		} catch (cause) {
			if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			refreshing.current = false;
			if (refreshPending.current) void refreshCurrent();
		}
	}, []);

	useEffect(() => {
		const version = ++generation.current;
		let active = true;
		current.current = null;
		setRecord(null);
		setSessions([]);
		setError(null);
		setBusy(false);
		refreshPending.current = false;
		if (!libraryRoot) return;
		setBusy(true);
		void (async () => {
			try {
				const list = await window.loom.listSessions();
				if (!active || version !== generation.current) return;
				const first = list.find((session) => session.status === "open");
				const next = first ? await window.loom.openSession(first.id) : await window.loom.createSession();
				if (!active || version !== generation.current) return;
				activateRecord(next);
				await refreshSessions();
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (active) setBusy(false);
			}
		})();
		const stop = window.loom.onSessionsChanged((list) => {
			if (!active) return;
			setSessions(list);
			if (current.current && list.some((session) => session.id === current.current?.id)) void refreshCurrent();
		});
		return () => { active = false; generation.current++; stop(); };
	}, [libraryRoot, activateRecord, refreshSessions, refreshCurrent]);

	async function perform(action: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try { await action(); }
		catch (cause) { if (library.current === libraryRoot) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (library.current === libraryRoot) setBusy(false); }
	}

	async function selectSession(id: string) {
		if (current.current?.id === id) return;
		await perform(async () => {
			if (sessions.find((session) => session.id === id)?.status === "archived") await window.loom.unarchiveSession(id);
			activateRecord(await window.loom.openSession(id));
			await refreshSessions();
		});
	}

	async function createSession() {
		await perform(async () => { activateRecord(await window.loom.createSession()); await refreshSessions(); });
	}

	async function archiveSession(id: string) {
		await perform(async () => {
			await window.loom.archiveSession(id);
			const list = await refreshSessions();
			if (current.current?.id !== id) return;
			const next = list.find((session) => session.status === "open");
			activateRecord(next ? await window.loom.openSession(next.id) : await window.loom.createSession());
			await refreshSessions();
		});
	}

	async function deleteSession(id: string) {
		if (!window.confirm(deleteConfirm)) return;
		await perform(async () => {
			if (current.current?.id === id) {
				const next = sessions.find((session) => session.id !== id && session.status === "open");
				activateRecord(next ? await window.loom.openSession(next.id) : await window.loom.createSession());
			}
			await window.loom.deleteSession(id);
			await refreshSessions();
		});
	}

	return { sessions, record: recordLibrary.current === libraryRoot ? record : null, busy, error, activateRecord, refreshSessions, refreshCurrent, createSession, selectSession, archiveSession, deleteSession };
}
