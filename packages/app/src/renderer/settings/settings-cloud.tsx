import { useEffect, useState } from "react";
import { CLOUD_PROVIDER_IDS, defaultCloudConfig, type CloudBackupView, type CloudConfigDraft, type CloudJob, type CloudProviderId } from "../../shared/cloud-backup.ts";
import { useLocale } from "../locale.tsx";
import { CloudProviderFields } from "./settings-cloud-providers.tsx";

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

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
		return () => { alive = false; unsubscribe(); };
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
	return <div className="settings-form">
		{error && <p role="alert" className="session-error">{error}</p>}
		{view && savedConfig && config ? <>
			<section className="settings-slot" aria-label={text.title}>
				<h3>{text.title}</h3>
				<p>{text.note}</p>
				<label>{text.provider}<select value={config.provider} disabled={busy} onChange={(event) => {
					const provider = event.target.value as CloudProviderId;
					if (provider !== config.provider) setDraft(provider === savedConfig.provider ? { ...savedConfig } : defaultCloudConfig(provider));
				}}>{CLOUD_PROVIDER_IDS.map((id) => <option key={id} value={id}>{text.providers[id]}</option>)}</select></label>
				<CloudProviderFields config={config} disabled={busy} onChange={setDraft} />
				<div className="settings-actions">
					<button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void save()}>{text.save}</button>
					<button type="button" disabled={busy || dirty || !view.hasCredentials} onClick={() => void start("test")}>{text.test}</button>
					<button type="button" disabled={busy || dirty || !view.hasCredentials} onClick={() => void start("backup")}>{text.backup}</button>
				</div>
				<p>{text.snapshotNote}</p>
			</section>
			{view.job && <section className="settings-slot cloud-progress" aria-label={text.progress} aria-live="polite">
				<strong>{text.operations[view.job.operation]} · {view.job.status === "running" ? text.phases[view.job.phase] : text.status[view.job.status]}</strong>
				{view.job.totalFiles > 0 && <><progress max={view.job.totalBytes || view.job.totalFiles} value={view.job.totalBytes ? view.job.completedBytes : view.job.completedFiles} /><span>{view.job.completedFiles} / {view.job.totalFiles} · {size(view.job.completedBytes)} / {size(view.job.totalBytes)}</span></>}
				{view.job.status === "running" && view.job.currentFile && <code>{view.job.currentFile}</code>}
				{view.job.error && <p role="alert" className="session-error">{view.job.error}</p>}
				{view.job.restoredPath && <><p>{text.restored}</p><code>{view.job.restoredPath}</code><button className="settings-button" type="button" disabled={busy} onClick={() => void run(() => window.loom.openRestoredCloudBackup())}>{text.openRestored}</button></>}
				{view.job.status === "running" && <button className="settings-button" type="button" onClick={() => void run(() => window.loom.cancelCloudBackup())}>{text.cancel}</button>}
			</section>}
			<section className="settings-slot" aria-label={text.libraries}>
				<div className="settings-slot-head"><h3 className="settings-slot-title">{text.libraries}</h3><button className="settings-button" type="button" disabled={busy || dirty || !view.hasCredentials} onClick={() => void start("list")}>{text.refresh}</button></div>
				{view.libraries.length === 0 && <p>{text.empty}</p>}
				{view.libraries.map((library) => <article className="cloud-library" key={library.libraryId}>
					<div><strong>{library.libraryName}</strong><time dateTime={library.updatedAt}>{new Date(library.updatedAt).toLocaleString()}</time><span>{library.deviceName} · {library.fileCount} {text.files} · {size(library.totalBytes)}</span>{library.state !== "ready" && <span>{text.incomplete}</span>}</div>
					<button className="settings-button" type="button" disabled={busy || dirty || library.state !== "ready"} onClick={() => void start("restore", library.libraryId)}>{text.restore}</button>
				</article>)}
			</section>
		</> : <div className="empty">{t.common.loading}</div>}
	</div>;
}
