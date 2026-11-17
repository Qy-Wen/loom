import { useEffect, useState } from "react";
import { CLOUD_PROVIDER_IDS, defaultCloudConfig, type CloudBackupView, type CloudConfigDraft, type CloudJob, type CloudPreview, type CloudProviderId } from "../../shared/cloud-backup.ts";
import { useLocale } from "../locale.tsx";
import { CloudProviderFields } from "./settings-cloud-providers.tsx";
import { TooltipText } from "../components/tooltip-text.tsx";
import { CloudPullPreviewPanel } from "./settings-cloud-pull.tsx";

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

function CloudGlyph({ kind }: { kind: "folder" | "cloud" | "upload" | "download" | "refresh" | "scan" | "chevron" | "shield" }) {
	return <svg className="cloud-glyph" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		{kind === "folder" && <path d="M2.5 6V4.5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6Z" />}
		{kind === "cloud" && <path d="M6 15.5H5a3.5 3.5 0 0 1-.4-7A5.5 5.5 0 0 1 15.2 7a4.3 4.3 0 0 1-.7 8.5H14M10 16V9m-2.5 2.5L10 9l2.5 2.5" />}
		{kind === "upload" && <path d="M10 13V3m-3.5 3.5L10 3l3.5 3.5M3 12v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />}
		{kind === "download" && <path d="M10 3v10m-3.5-3.5L10 13l3.5-3.5M3 13v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />}
		{kind === "refresh" && <path d="M16.5 8A6.8 6.8 0 0 0 5 4.8L3 7m0-4v4h4m-3.5 5A6.8 6.8 0 0 0 15 15.2l2-2.2m0 4v-4h-4" />}
		{kind === "scan" && <><path d="M7 3H4a1 1 0 0 0-1 1v3m10-4h3a1 1 0 0 1 1 1v3M3 13v3a1 1 0 0 0 1 1h3m10-4v3a1 1 0 0 1-1 1h-3M7 8h6m-6 4h4" /></>}
		{kind === "chevron" && <path d="m7 5 5 5-5 5" />}
		{kind === "shield" && <path d="m10 2.5 6.5 2v5c0 4-3.5 6.5-6.5 8-3-1.5-6.5-4-6.5-8v-5l6.5-2Zm-3 7 2 2 4-4" />}
	</svg>;
}

function ChangePreview({ preview }: { preview: CloudPreview }): React.JSX.Element {
	const { t } = useLocale(); const text = t.settings.cloud;
	const [limit, setLimit] = useState(100);
	useEffect(() => setLimit(100), [preview.checkedAt]);
	const originals = preview.changes.filter((change) => change.path !== ".loom" && !change.path.startsWith(".loom/"));
	const metadata = preview.changes.filter((change) => change.path === ".loom" || change.path.startsWith(".loom/"));
	function group(changes: CloudPreview["changes"], label: string, open: boolean) {
		return <details className="cloud-change-group" open={open}>
			<summary><CloudGlyph kind="chevron" /><span>{label}</span><span className="cloud-count">{changes.length}</span></summary>
			<ul className="cloud-change-list thin-scroll">{changes.slice(0, limit).map((change) => <li key={`${change.kind}:${change.path}`}>
				<span className="cloud-change-kind" data-kind={change.kind}>{text.changeKinds[change.kind]}</span>
				<code>{change.path}{change.type === "directory" ? "/" : ""}</code>
				<small>{change.type === "file" ? size(change.size) : "—"}</small>
			</li>)}</ul>
			{changes.length > limit && <button className="settings-button cloud-show-more" type="button" onClick={() => setLimit((value) => value + 100)}>{text.showMore} ({changes.length - limit})</button>}
		</details>;
	}
	return <div className="cloud-preview">
		<div className="cloud-preview-heading"><h4>{text.preview}</h4><time dateTime={preview.checkedAt}>{text.checkedAt} {new Date(preview.checkedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
		{preview.stale && <p className="cloud-notice" role="status">{text.stalePreview}</p>}
		{preview.repair && <p className="cloud-notice">{text.repairPreview}</p>}
		<dl className="cloud-change-summary">{(["added", "modified", "deleted"] as const).map((kind) => <div key={kind} data-kind={kind}><dt>{text.changeKinds[kind]}</dt><dd>{preview.changes.filter((change) => change.kind === kind).length}</dd></div>)}<div className="cloud-upload-estimate"><dt>{text.uploadEstimate}</dt><dd>{size(preview.uploadBytes)}</dd></div></dl>
		{preview.changes.length === 0 && <p className="cloud-no-changes">{text.noChanges}</p>}
		{originals.length > 0 && group(originals, text.changeList, true)}
		{metadata.length > 0 && group(metadata, text.metadataChanges, false)}
	</div>;
}

function JobProgress({ job, busy, onCancel, onOpen }: { job: CloudJob; busy: boolean; onCancel(): void; onOpen(): void }) {
	const { t } = useLocale(); const text = t.settings.cloud;
	return <section className="cloud-progress" data-status={job.status} aria-label={text.progress} aria-live="polite">
		<div className="cloud-progress-heading"><span className="cloud-state-dot" /><strong>{text.operations[job.operation]}</strong><span>{job.status === "running" ? text.phases[job.phase] : text.status[job.status]}</span>{job.status === "running" && <button className="settings-button" type="button" onClick={onCancel}>{text.cancel}</button>}</div>
		{job.status === "running" && job.totalFiles > 0 && <><progress max={job.totalBytes || job.totalFiles} value={job.totalBytes ? job.completedBytes : job.completedFiles} /><span className="cloud-progress-amount">{job.completedFiles} / {job.totalFiles} · {size(job.completedBytes)} / {size(job.totalBytes)}</span></>}
		{job.operation === "backup" && job.uploadedBytes !== undefined && <span className="cloud-progress-amount">{text.uploaded}: {size(job.uploadedBytes)} · {text.skippedFiles(job.skippedFiles ?? 0)}</span>}
		{job.status === "running" && job.rootPath && <code className="cloud-job-path">{job.rootPath}</code>}
		{(job.status === "running" || job.status === "failed") && job.currentFile && <code className="cloud-job-path">{job.currentFile}</code>}
		{job.error && <p role="alert" className="session-error">{job.error}</p>}
		{job.restoredPath && <div className="cloud-restored"><p>{text.restored}</p><code>{job.restoredPath}</code><button className="settings-button" type="button" disabled={busy} onClick={onOpen}><CloudGlyph kind="folder" />{text.openRestored}</button></div>}
	</section>;
}

export function SettingsCloud(): React.JSX.Element {
	const { t } = useLocale(); const text = t.settings.cloud;
	const [view, setView] = useState<CloudBackupView | null>(null);
	const [savedConfig, setSavedConfig] = useState<CloudConfigDraft | null>(null);
	const [draft, setDraft] = useState<CloudConfigDraft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		let alive = true, received = false;
		const unsubscribe = window.loom.onCloudBackupChanged((next) => { received = true; if (alive) setView(next); });
		void Promise.allSettled([window.loom.getCloudBackup(), window.loom.getCloudBackupConfig()]).then(([status, configuration]) => {
			if (!alive) return;
			if (status.status === "fulfilled" && !received) setView(status.value);
			if (configuration.status === "fulfilled") setSavedConfig(configuration.value);
			else if (status.status === "fulfilled") setSavedConfig(status.value.config);
			const failure = status.status === "rejected" ? status.reason : configuration.status === "rejected" ? configuration.reason : undefined;
			if (failure) setError(failure instanceof Error ? failure.message : String(failure));
		});
		return () => {
			alive = false; unsubscribe();
			// Pull keeps this library paused while choices are pending.
			void window.loom.getCloudBackup().then((current) => { if (current.job?.operation === "pull" && current.job.status === "running") return window.loom.cancelCloudBackup(); }).catch(() => {});
		};
	}, []);
	const busy = pending || view?.job?.status === "running";
	const config = draft ?? savedConfig;
	const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(savedConfig);
	async function run(operation: () => Promise<unknown>): Promise<void> {
		setPending(true); setError(null);
		try { await operation(); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setPending(false); }
	}
	async function save(): Promise<void> {
		if (!draft) return;
		await run(async () => {
			const next = await window.loom.saveCloudBackup(draft);
			const saved = await window.loom.getCloudBackupConfig();
			setView(next); setSavedConfig(saved); setDraft(null);
		});
	}
	const start = (operation: CloudJob["operation"], id?: string) => run(() => window.loom.startCloudBackup(operation, id));
	const local = view?.localLibrary;
	const disabled = busy || dirty || !view?.hasCredentials;
	const job = view?.job;
	const enabled = view?.config.provider !== "none" && config?.provider !== "none";
	const progress = job && !(job.operation === "preview" && job.status === "completed") && <JobProgress job={job} busy={!!busy} onCancel={() => void run(() => window.loom.cancelCloudBackup())} onOpen={() => void run(() => window.loom.openRestoredCloudBackup())} />;
	return <div className="settings-form cloud-settings">
		{error && <p role="alert" className="session-error">{error}</p>}
		{view && savedConfig && config ? <>
			{enabled && <>
				<section className="settings-slot cloud-panel cloud-local" aria-label={text.localLibrary}>
					<div className="cloud-panel-heading"><h3>{text.localLibrary}</h3>{local && <span className="cloud-state" data-state={local.status} role="status" aria-label={text.localStatus[local.status]} data-tooltip={text.localStatus[local.status]}><span className="cloud-state-dot" />{text.localBadge[local.status]}</span>}</div>
					{local ? <>
						<div className="cloud-library-identity"><span className="cloud-icon-tile"><CloudGlyph kind="folder" /></span><div><strong>{local.libraryName}</strong><div className="cloud-root-path"><TooltipText text={local.rootPath} tooltip={local.rootPath} /></div></div></div>
						<div className="cloud-backup-meta"><span>{text.lastBackup}</span>{local.lastBackupAt ? <time dateTime={local.lastBackupAt}>{new Date(local.lastBackupAt).toLocaleString()}</time> : <span>{text.neverBackedUp}</span>}</div>
						{local.error && <p role="alert" className="session-error cloud-local-error">{local.error}</p>}
						{(!view.hasCredentials || dirty) && <p className="cloud-notice">{dirty ? text.unsavedConfig : text.configureFirst}</p>}
						<div className="settings-actions cloud-backup-actions">
							<button type="button" disabled={disabled} onClick={() => void start("preview")}><CloudGlyph kind="scan" />{text.preview}</button>
							<button type="button" disabled={disabled || !local.libraryId} onClick={() => void start("pull")}><CloudGlyph kind="download" />{text.pull}</button>
							{local.status === "failed" && <button type="button" disabled={disabled} onClick={() => void start(local.retryOperation ?? "preview")}><CloudGlyph kind="refresh" />{text.retry}</button>}
							<button type="button" className="primary-button" disabled={disabled} onClick={() => void start("backup")}><CloudGlyph kind="upload" />{text.backup}</button>
						</div>
						{job && job.operation !== "test" && job.operation !== "list" && progress}
						{view.pull && job?.status === "running" && job.phase === "conflicts" ? <CloudPullPreviewPanel preview={view.pull} disabled={pending} onApply={(choices) => void run(() => window.loom.resolveCloudPull(view.pull!.id, choices))} /> : local.preview && <ChangePreview preview={local.preview} />}
					</> : <div className="cloud-empty"><CloudGlyph kind="folder" /><p>{text.noLibrary}</p></div>}
					<details className="cloud-help"><summary><CloudGlyph kind="chevron" />{text.backupDetails}</summary><p>{text.snapshotNote}</p><p>{text.previewNote}</p></details>
				</section>
				<section className="settings-slot cloud-panel" aria-label={text.libraries}>
					<div className="cloud-panel-heading"><h3>{text.libraries}</h3><button className="settings-button cloud-quiet-button" type="button" disabled={disabled} onClick={() => void start("list")}><CloudGlyph kind="refresh" />{text.refresh}</button></div>
					{job?.operation === "list" && progress}
					{view.libraries.length === 0 && <div className="cloud-empty"><CloudGlyph kind="cloud" /><p>{text.empty}</p></div>}
					{view.libraries.map((library) => <article className="cloud-library" key={library.libraryId}>
						<span className="cloud-icon-tile"><CloudGlyph kind="folder" /></span>
						<div className="cloud-library-info"><strong>{library.libraryName}</strong><time dateTime={library.updatedAt}>{new Date(library.updatedAt).toLocaleString()}</time><span>{library.deviceName} · {library.fileCount} {text.files} · {size(library.totalBytes)}</span>{library.state !== "ready" && <span className="cloud-incomplete">{text.incomplete}</span>}</div>
						<button className="settings-button" type="button" disabled={busy || dirty || library.state !== "ready"} onClick={() => void start("restore", library.libraryId)}><CloudGlyph kind="download" />{text.restore}</button>
					</article>)}
				</section>
			</>}
			<section className="settings-slot cloud-panel cloud-connection" aria-label={text.title}>
				<div className="cloud-panel-heading"><h3>{text.title}</h3>{view.hasCredentials && config.provider !== "none" && <span className="cloud-configured">{text.configured}</span>}</div>
				<div className="cloud-connection-grid">
					<label>{text.provider}<select value={config.provider} disabled={busy} onChange={(event) => {
						const provider = event.target.value as CloudProviderId;
						if (provider !== config.provider) void run(async () => {
							if (provider === savedConfig.provider) setDraft({ ...savedConfig });
							else {
								setDraft(defaultCloudConfig(provider));
								if (provider !== "none") setDraft(await window.loom.getCloudBackupConfig(provider));
							}
						});
					}}>{CLOUD_PROVIDER_IDS.map((id) => <option key={id} value={id}>{text.providers[id]}</option>)}</select></label>
					<CloudProviderFields config={config} disabled={busy} onChange={setDraft} />
					{config.provider === "none" && <p className="cloud-field-help">{dirty ? text.disableOnSave : text.disabledNote}</p>}
				</div>
				<div className="cloud-connection-footer">{config.provider !== "none" && <p><CloudGlyph kind="shield" />{text.note}</p>}<div className="settings-actions">
					{config.provider !== "none" && <button type="button" disabled={disabled} onClick={() => void start("test")}>{text.test}</button>}
					<button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void save()}>{text.save}</button>
				</div></div>
				{enabled && job?.operation === "test" && progress}
			</section>
		</> : <div className="empty">{t.common.loading}</div>}
	</div>;
}
