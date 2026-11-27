import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	CreateSkillInput,
	SkillDetail,
	SkillScope,
	SkillSummary,
	SkillsSettingsView,
	UpdateSkillInput,
} from "../../shared/skills-settings.ts";
import { useConfirmation } from "../components/confirm-dialog.tsx";
import { useLocale } from "../locale.tsx";
import { SettingsSkillsEditor } from "./settings-skills-editor.tsx";

type ViewMode =
	| { kind: "list" }
	| { kind: "create" }
	| { kind: "edit"; detail: SkillDetail };

function matchesQuery(skill: SkillSummary, query: string): boolean {
	if (!query) return true;
	const needle = query.toLowerCase();
	return skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle);
}

export function SettingsSkills(): React.JSX.Element {
	const { t } = useLocale();
	const copy = t.settings.skills;
	const { confirm } = useConfirmation("settings-skills");

	const [view, setView] = useState<SkillsSettingsView | null>(null);
	const [mode, setMode] = useState<ViewMode>({ kind: "list" });
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const next = await window.loom.getSkillsSettings();
			setView(next);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const trimmedQuery = query.trim();
	const filteredLibrary = useMemo(
		() => (view?.library ?? []).filter((skill) => matchesQuery(skill, trimmedQuery)),
		[view, trimmedQuery],
	);
	const filteredUser = useMemo(
		() => (view?.user ?? []).filter((skill) => matchesQuery(skill, trimmedQuery)),
		[view, trimmedQuery],
	);

	async function runAction<T>(operation: () => Promise<T>): Promise<T | undefined> {
		setBusy(true);
		setError(null);
		try {
			return await operation();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return undefined;
		} finally {
			setBusy(false);
		}
	}

	async function handleToggle(skill: SkillSummary, enabled: boolean): Promise<void> {
		const next = await runAction(() => window.loom.setSkillEnabled(skill.scope, skill.name, enabled));
		if (next) setView(next);
	}

	async function handleEdit(skill: SkillSummary): Promise<void> {
		const detail = await runAction(() => window.loom.readSkill(skill.scope, skill.id));
		if (detail) setMode({ kind: "edit", detail });
	}

	async function handleCreate(input: CreateSkillInput): Promise<void> {
		const created = await runAction(() => window.loom.createSkill(input));
		if (!created) return;
		await load();
		setMode({ kind: "list" });
	}

	async function handleSave(input: UpdateSkillInput): Promise<void> {
		const saved = await runAction(() => window.loom.saveSkill(input));
		if (!saved) return;
		await load();
		setMode({ kind: "list" });
	}

	async function handleDelete(skill: SkillSummary): Promise<void> {
		const ok = await confirm({
			title: copy.deleteTitle(skill.name),
			description: skill.kind === "directory"
				? copy.deleteDirectoryDescription(skill.name)
				: copy.deleteFileDescription(skill.name),
			confirmLabel: copy.deleteConfirm,
			tone: "danger",
		});
		if (!ok) return;
		const next = await runAction(() => window.loom.deleteSkill(skill.scope, skill.id));
		if (next) setView(next);
	}

	async function handleOpenFolder(scope: SkillScope, targetPath?: string): Promise<void> {
		await runAction(() => window.loom.openSkillsFolder(scope, targetPath));
	}

	if (!view) {
		return (
			<div className="settings-form">
				{error ? <div className="session-error" role="alert">{error}</div> : <div className="empty">{t.common.loading}</div>}
			</div>
		);
	}

	if (mode.kind === "create") {
		return (
			<div className="skills-pane">
				{error && <div className="session-error" role="alert">{error}</div>}
				<SettingsSkillsEditor
					mode="create"
					hasLibrary={view.libraryDir !== null}
					existingNames={{
						user: view.user.map((s) => s.name),
						library: view.library.map((s) => s.name),
					}}
					busy={busy}
					onCancel={() => { setError(null); setMode({ kind: "list" }); }}
					onCreate={handleCreate}
				/>
			</div>
		);
	}

	if (mode.kind === "edit") {
		return (
			<div className="skills-pane">
				{error && <div className="session-error" role="alert">{error}</div>}
				<SettingsSkillsEditor
					mode="edit"
					detail={mode.detail}
					busy={busy}
					onCancel={() => { setError(null); setMode({ kind: "list" }); }}
					onSave={handleSave}
					onReveal={handleOpenFolder}
				/>
			</div>
		);
	}

	function renderScopeSection(scope: SkillScope, dir: string | null, allSkills: SkillSummary[], filtered: SkillSummary[]) {
		return (
			<section className="settings-slot skills-scope" aria-label={copy.scopes[scope]}>
				<div className="settings-slot-head skills-scope-head">
					<div className="skills-scope-title-group">
						<span className="settings-slot-title">{copy.scopes[scope]}</span>
						<span className="skills-count">{allSkills.length}</span>
					</div>
					{dir && (
						<button
							className="settings-button skills-quiet-button"
							type="button"
							disabled={busy}
							onClick={() => void handleOpenFolder(scope)}
						>
							{copy.openFolder}
						</button>
					)}
				</div>
				<p>{copy.scopeNotes[scope]}</p>
				{dir ? <p className="settings-path"><code>{dir}</code></p> : <p className="skills-empty-note">{copy.noLibrary}</p>}

				{dir && allSkills.length === 0 && (
					<p className="skills-empty-note">{copy.emptyScope}</p>
				)}
				{dir && allSkills.length > 0 && filtered.length === 0 && (
					<p className="skills-empty-note">{copy.noMatches}</p>
				)}
				{dir && filtered.length > 0 && (
					<ul className="skills-list">
						{filtered.map((skill) => (
							<li
								key={`${skill.scope}:${skill.id}`}
								className={[
									"skills-item",
									!skill.enabled ? "is-disabled" : "",
									skill.overriddenByLibrary ? "is-overridden" : "",
								].filter(Boolean).join(" ")}
							>
								<div className="skills-item-main">
									<div className="skills-item-top">
										<code className="skills-item-name">/{skill.name}</code>
										<div className="skills-badges">
											{skill.overridesUser && <span className="skills-badge is-accent">{copy.badges.overridesUser}</span>}
											{skill.overriddenByLibrary && <span className="skills-badge is-warning">{copy.badges.overriddenByLibrary}</span>}
											{skill.disableModelInvocation && <span className="skills-badge">{copy.badges.manualOnly}</span>}
											{skill.kind === "file" && <span className="skills-badge">{copy.badges.singleFile}</span>}
											{skill.supportingFileCount > 0 && (
												<span className="skills-badge">{copy.badges.supportingFiles(skill.supportingFileCount)}</span>
											)}
										</div>
									</div>
									<p className="skills-item-description">{skill.description}</p>
									<div className="skills-item-actions">
										<button
											className="settings-button skills-quiet-button"
											type="button"
											disabled={busy}
											onClick={() => void handleEdit(skill)}
										>
											{copy.edit}
										</button>
										<button
											className="settings-button skills-quiet-button skills-delete-button"
											type="button"
											disabled={busy}
											onClick={() => void handleDelete(skill)}
										>
											{copy.delete}
										</button>
									</div>
								</div>
								<div className="skills-item-switch">
									<label className="settings-switch">
										<input
											type="checkbox"
											role="switch"
											checked={skill.enabled}
											disabled={busy}
											aria-label={copy.enableLabel(skill.name)}
											onChange={(event) => void handleToggle(skill, event.target.checked)}
										/>
										<span className="settings-switch-ui" aria-hidden="true" />
									</label>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>
		);
	}

	return (
		<div className="settings-form settings-form-docked skills-pane">
			{error && <div className="session-error" role="alert">{error}</div>}

			<div className="skills-toolbar">
				<input
					className="skills-search"
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={copy.searchPlaceholder}
					aria-label={copy.searchLabel}
				/>
				<div className="skills-toolbar-actions">
					<button
						className="settings-button"
						type="button"
						disabled={busy}
						onClick={() => void runAction(load)}
					>
						{copy.refresh}
					</button>
					<button
						className="settings-button primary-button"
						type="button"
						disabled={busy}
						onClick={() => { setError(null); setMode({ kind: "create" }); }}
					>
						{copy.newSkill}
					</button>
				</div>
			</div>

			<div className="settings-form-scroll thin-scroll skills-list-scroll">
				{view.diagnostics.length > 0 && (
					<details className="settings-slot skills-diagnostics" open>
						<summary className="skills-diagnostics-summary">
							<span>{copy.diagnosticsTitle(view.diagnostics.length)}</span>
						</summary>
						<p>{copy.diagnosticsNote}</p>
						<ul className="skills-diagnostics-list">
							{view.diagnostics.map((item, index) => (
								<li key={`${item.scope}:${item.path}:${index}`}>
									<div className="skills-diagnostic-copy">
										<span className="skills-badge is-warning">{copy.scopes[item.scope]}</span>
										<span className="skills-diagnostic-message">{item.message}</span>
										<code className="skills-diagnostic-path">{item.path}</code>
									</div>
									<button
										className="settings-button skills-quiet-button"
										type="button"
										disabled={busy}
										onClick={() => void handleOpenFolder(item.scope, item.path)}
									>
										{copy.reveal}
									</button>
								</li>
							))}
						</ul>
					</details>
				)}

				{renderScopeSection("library", view.libraryDir, view.library, filteredLibrary)}
				{renderScopeSection("user", view.userDir, view.user, filteredUser)}
			</div>
		</div>
	);
}
