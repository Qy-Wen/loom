import { useEffect } from "react";
import type { Asset } from "@loom/core";
import type { AssetRefAttachment } from "@loom/agent";
import { useLocale } from "../locale.tsx";
import { SessionBar } from "./session-bar.tsx";
import { SessionChat } from "./session-chat.tsx";
import { useSessions } from "./use-sessions.ts";
import { AgentPermissionProvider } from "./agent-permission.tsx";
import { AssetOpenProvider, LibraryAssetsProvider } from "./asset-open.tsx";
import { setCommandAllows } from "./command-allows.ts";
import { ToolCallViews } from "./tool-call-views.tsx";

interface AgentPanelProps {
	libraryRoot: string | null;
	assets: Asset[];
	onOpenAsset: (assetId: string) => void;
	composerAttach: AssetRefAttachment | null;
	onComposerAttachApplied: () => void;
}

export function AgentPanel({
	libraryRoot,
	assets,
	onOpenAsset,
	composerAttach,
	onComposerAttachApplied,
}: AgentPanelProps): React.JSX.Element {
	const { t } = useLocale();
	const {
		sessions, record, busy: sessionBusy, error: sessionError,
		activateRecord, refreshSessions, refreshCurrent, createSession, selectSession, archiveSession, deleteSession,
	} = useSessions(libraryRoot, t.sessions.deleteConfirm);
	const sessionId = record?.id ?? null;

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
			<div className="panel-content agent-content active">
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
						/>
						{sessionError && <div className="session-error">{sessionError}</div>}
						{sessionId ? (
							<AssetOpenProvider onOpen={onOpenAsset}>
							<LibraryAssetsProvider assets={assets}>
							<AgentPermissionProvider>
							<div className="agent-chat">
								<ToolCallViews libraryRoot={libraryRoot} />
								<SessionChat
									threadId={sessionId}
									messages={record!.messages}
									context={record!.context ?? null}
									model={record!.model}
									composerAttach={composerAttach}
									onComposerAttachApplied={onComposerAttachApplied}
									onSessionRecord={activateRecord}
									onHistoryChanged={() => { void refreshCurrent(); }}
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
}
