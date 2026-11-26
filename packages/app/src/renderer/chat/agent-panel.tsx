import { memo, useEffect, useState } from "react";
import type { Asset } from "@loom/core";
import type { AssetRefAttachment } from "@loom/agent";
import { useLocale } from "../locale.tsx";
import { SessionBar } from "./session-bar.tsx";
import { SessionChat } from "./session-chat.tsx";
import { useSessions } from "./use-sessions.ts";
import { AgentPermissionProvider } from "./agent-permission.tsx";
import { AssetOpenProvider, LibraryAssetsProvider } from "./asset-open.tsx";
import { setCommandAllows } from "./command-allows.ts";
import type { AgentEndpoint } from "../../shared/ipc.ts";
import { isImeComposing } from "../components/ime-composition.ts";

interface AgentPanelProps {
	endpoint: AgentEndpoint | null;
	libraryRoot: string | null;
	assets: Asset[];
	folders: string[];
	onOpenAsset: (assetId: string) => void;
	onOpenFolder: (path: string) => void;
	composerAttach: AssetRefAttachment | null;
	onComposerAttachApplied: () => void;
	onOpenSettings: () => void;
}

export const AgentPanel = memo(function AgentPanel({
	endpoint,
	libraryRoot,
	assets,
	folders,
	onOpenAsset,
	onOpenFolder,
	composerAttach,
	onComposerAttachApplied,
	onOpenSettings,
}: AgentPanelProps): React.JSX.Element {
	const { t } = useLocale();
	const {
		sessions, record, busy: sessionBusy, error: sessionError,
		activateRecord, refreshSessions, refreshCurrent, createSession, selectSession, archiveSession, deleteSession,
	} = useSessions(libraryRoot);
	const sessionId = record?.id ?? null;
	const [findRequest, setFindRequest] = useState<{ threadId: string; returnFocus: HTMLElement | null } | null>(null);
	const activeFind = findRequest?.threadId === sessionId ? findRequest : null;
	function openFind() {
		if (!sessionId || !endpoint) return;
		const previous = document.activeElement;
		setFindRequest({ threadId: sessionId, returnFocus: activeFind ? activeFind.returnFocus : previous instanceof HTMLElement ? previous : null });
	}

	function closeFind() {
		setFindRequest(null);
		activeFind?.returnFocus?.focus({ preventScroll: true });
	}

	useEffect(() => {
		setFindRequest((request) => request?.threadId === sessionId ? request : null);
	}, [sessionId]);

	useEffect(() => {
		if (!libraryRoot) {
			setCommandAllows({ allows: [], libraryOpen: false, root: null });
			return;
		}
		let active = true;
		const apply = (view: { root: string | null }) => active && view.root === libraryRoot;
		void window.loom.getCommandAllows().then((view) => {
			if (apply(view)) setCommandAllows(view);
		}).catch(() => undefined);
		const stop = window.loom.onCommandAllowsChanged((view) => {
			if (apply(view)) setCommandAllows(view);
		});
		return () => {
			active = false;
			stop();
		};
	}, [libraryRoot]);

	return (
		<div className="side-panel">
			<div className="panel-content agent-content active" tabIndex={-1} onKeyDown={(event) => {
				if (event.defaultPrevented || isImeComposing(event.nativeEvent)) return;
				if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f" && sessionId && endpoint) {
					event.preventDefault();
					openFind();
				} else if (event.key === "Escape" && activeFind) {
					event.preventDefault();
					closeFind();
				}
			}}>
				{libraryRoot ? (
					<>
						<SessionBar
							sessions={sessions}
							currentId={sessionId}
							currentEmpty={record?.messages.length === 0}
							busy={sessionBusy}
							onCreate={() => void createSession()}
							onSelect={(id) => void selectSession(id)}
							onArchive={(id) => void archiveSession(id)}
							onUnarchive={(id) => void selectSession(id)}
							onDelete={(id) => void deleteSession(id)}
							onRefresh={() => void refreshSessions().catch(() => undefined)}
							onFind={sessionId && endpoint ? openFind : undefined}
							findOpen={activeFind !== null}
						/>
						{sessionError && <div className="session-error">{sessionError}</div>}
						{sessionId && endpoint ? (
							<AssetOpenProvider onOpen={onOpenAsset} onOpenFolder={onOpenFolder}>
							<LibraryAssetsProvider assets={assets} folders={folders}>
							<AgentPermissionProvider>
							<div className="agent-chat">
								<SessionChat
									key={libraryRoot}
									endpoint={endpoint}
									libraryRoot={libraryRoot}
									threadId={sessionId}
									messages={record!.messages}
									context={record!.context ?? null}
									model={record!.model}
									composerAttach={composerAttach}
									onComposerAttachApplied={onComposerAttachApplied}
									onSessionRecord={activateRecord}
									onHistoryChanged={() => { void refreshCurrent(); }}
									onOpenSettings={onOpenSettings}
									findRequest={activeFind}
									onCloseFind={closeFind}
									onForked={(record) => {
										activateRecord(record);
										void refreshSessions().catch(() => undefined);
									}}
								/>
							</div>
							</AgentPermissionProvider>
							</LibraryAssetsProvider>
							</AssetOpenProvider>
						) : (
							<div className="empty">{t.sessions.starting}</div>
						)}
					</>
				) : (
					<div className="empty">{t.sessions.needLibrary}</div>
				)}
			</div>
		</div>
	);
});
