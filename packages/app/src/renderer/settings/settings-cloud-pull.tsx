import { useEffect, useState } from "react";
import type { CloudPullChoice, CloudPullPreview } from "../../shared/cloud-backup.ts";
import { useLocale } from "../locale.tsx";

export function CloudPullPreviewPanel({ preview, disabled, onApply }: { preview: CloudPullPreview; disabled: boolean; onApply(choices: Record<string, CloudPullChoice>): void }) {
	const { t } = useLocale(); const text = t.settings.cloud;
	const [choices, setChoices] = useState<Record<string, CloudPullChoice>>({});
	const [limit, setLimit] = useState(100);
	useEffect(() => { setChoices({}); setLimit(100); }, [preview.id]);
	const conflicts = preview.changes.filter((change) => change.conflict);
	const remaining = conflicts.filter((change) => !choices[change.id]).length;
	const downloadBytes = preview.changes.filter((change) => (change.choice ?? choices[change.id]) === "remote").reduce((sum, change) => sum + change.downloadBytes, 0);
	return <section className="cloud-preview cloud-pull-preview" aria-label={text.pullPreview}>
		<div className="cloud-preview-heading"><h4>{text.pullPreview}</h4><span>{text.conflictCount(conflicts.length)}</span></div>
		<p className="cloud-notice">{text.pullPaused}</p>
		{preview.firstSync && <p className="cloud-notice">{text.firstPull}</p>}
		{preview.changes.some((change) => change.type === "metadata") && <p className="cloud-field-help">{text.pullMetadataNote}</p>}
		{conflicts.length > 0 && <div className="settings-actions cloud-pull-bulk"><button type="button" disabled={disabled} onClick={() => setChoices(Object.fromEntries(conflicts.map((change) => [change.id, "local"])))}>{text.allLocal}</button><button type="button" disabled={disabled} onClick={() => setChoices(Object.fromEntries(conflicts.map((change) => [change.id, "remote"])))}>{text.allRemote}</button></div>}
		{preview.changes.length === 0 ? <p className="cloud-no-changes">{text.noChanges}</p> : <ul className="cloud-pull-list thin-scroll">{preview.changes.slice(0, limit).map((change) => <li key={change.id} data-conflict={change.conflict}>
			<div className="cloud-pull-file"><code>{change.type === "metadata" ? text.metadataChanges : `${change.path}${change.type === "directory" ? "/" : ""}`}</code>{change.conflict && <span className="cloud-incomplete">{text.conflict}</span>}</div>
			{change.conflict ? <fieldset disabled={disabled} className="cloud-pull-choices" aria-label={change.path}>{(["local", "remote"] as const).map((choice) => <label key={choice}><input type="radio" name={`pull-${preview.id}-${change.id}`} checked={choices[change.id] === choice} onChange={() => setChoices((current) => ({ ...current, [change.id]: choice }))} /><span>{choice === "local" ? text.keepLocal : text.useRemote}{!(choice === "local" ? change.localExists : change.remoteExists) && ` · ${text.deletedSide}`}</span></label>)}</fieldset> : <span className="cloud-field-help">{change.choice === "local" ? text.keepLocal : text.useRemote}{!(change.choice === "local" ? change.localExists : change.remoteExists) && ` · ${text.deletedSide}`}</span>}
		</li>)}</ul>}
		{preview.changes.length > limit && <button type="button" className="settings-button cloud-show-more" onClick={() => setLimit((value) => value + 100)}>{text.showMore} ({preview.changes.length - limit})</button>}
		<div className="settings-actions cloud-pull-footer"><span>{text.pullDownload}: {(downloadBytes / 1024 ** 2).toFixed(2)} MB{remaining > 0 && ` · ${text.unresolvedConflicts(remaining)}`}</span><button type="button" className="primary-button" disabled={disabled || remaining > 0} onClick={() => onApply(choices)}>{text.applyPull}</button></div>
	</section>;
}
