import { useMemo, useState } from "react";
import {
	SKILL_DESCRIPTION_MAX_LENGTH,
	isReservedSkillName,
	isValidSkillName,
	type CreateSkillInput,
	type SkillDetail,
	type SkillScope,
	type UpdateSkillInput,
} from "../../shared/skills-settings.ts";
import { useLocale } from "../locale.tsx";

interface CreateProps {
	mode: "create";
	hasLibrary: boolean;
	existingNames: Record<SkillScope, readonly string[]>;
	busy: boolean;
	onCancel: () => void;
	onCreate: (input: CreateSkillInput) => Promise<void>;
}

interface EditProps {
	mode: "edit";
	detail: SkillDetail;
	busy: boolean;
	onCancel: () => void;
	onSave: (input: UpdateSkillInput) => Promise<void>;
	onReveal: (scope: SkillScope, targetPath: string) => Promise<void>;
}

export type SettingsSkillsEditorProps = CreateProps | EditProps;

export function SettingsSkillsEditor(props: SettingsSkillsEditorProps): React.JSX.Element {
	const { t } = useLocale();
	const copy = t.settings.skills;
	const isCreate = props.mode === "create";

	const [scope, setScope] = useState<SkillScope>("user");
	const [name, setName] = useState("");
	const [description, setDescription] = useState(isCreate ? "" : props.detail.description);
	const [content, setContent] = useState(isCreate ? "" : props.detail.content);
	const [touchedName, setTouchedName] = useState(false);
	const [touchedDescription, setTouchedDescription] = useState(false);

	const trimmedName = name.trim();
	const trimmedDescription = description.trim();

	const nameError = useMemo(() => {
		if (!isCreate) return null;
		if (!trimmedName) return copy.nameInvalid;
		if (isReservedSkillName(trimmedName)) return copy.nameReserved;
		if (!isValidSkillName(trimmedName)) return copy.nameInvalid;
		const taken = props.existingNames[scope].some((existing) => existing.toLowerCase() === trimmedName.toLowerCase());
		if (taken) return copy.nameDuplicate;
		return null;
	}, [isCreate, trimmedName, scope, copy, props]);

	const descriptionError = useMemo(() => {
		if (!trimmedDescription) return copy.descriptionRequired;
		if (trimmedDescription.length > SKILL_DESCRIPTION_MAX_LENGTH) {
			return copy.descriptionTooLong(SKILL_DESCRIPTION_MAX_LENGTH);
		}
		return null;
	}, [trimmedDescription, copy]);

	const canSubmit = !props.busy && !nameError && !descriptionError;

	async function handleSubmit(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setTouchedName(true);
		setTouchedDescription(true);
		if (!canSubmit) return;
		if (props.mode === "create") {
			await props.onCreate({
				scope,
				name: trimmedName,
				description: trimmedDescription,
				content,
			});
		} else {
			await props.onSave({
				scope: props.detail.scope,
				id: props.detail.id,
				description: trimmedDescription,
				content,
			});
		}
	}

	return (
		<form className="settings-form settings-form-docked skills-editor" onSubmit={(event) => void handleSubmit(event)}>
			<div className="skills-editor-head">
				<button className="settings-button" type="button" disabled={props.busy} onClick={props.onCancel}>
					{copy.back}
				</button>
				<h4 className="skills-editor-title">
					{isCreate ? copy.createTitle : copy.editTitle(props.detail.name)}
				</h4>
				{!isCreate && (
					<button
						className="settings-button"
						type="button"
						disabled={props.busy}
						onClick={() => void props.onReveal(props.detail.scope, props.detail.filePath)}
					>
						{copy.reveal}
					</button>
				)}
			</div>

			<div className="settings-form-scroll thin-scroll skills-editor-scroll">
				<section className="settings-slot skills-editor-card">
					{isCreate && (
						<>
							<div className="skills-field">
								<span className="skills-field-label">{copy.scopeLabel}</span>
								<div className="settings-kind" role="radiogroup" aria-label={copy.scopeLabel}>
									<label className={scope === "user" ? "is-active" : undefined}>
										<input
											type="radio"
											name="skill-create-scope"
											checked={scope === "user"}
											disabled={props.busy}
											onChange={() => setScope("user")}
										/>
										{copy.scopes.user}
									</label>
									<label className={scope === "library" ? "is-active" : undefined}>
										<input
											type="radio"
											name="skill-create-scope"
											checked={scope === "library"}
											disabled={props.busy || !props.hasLibrary}
											onChange={() => setScope("library")}
										/>
										{copy.scopes.library}
									</label>
								</div>
							</div>

							<label>
								{copy.nameLabel}
								<input
									value={name}
									onChange={(event) => {
										setName(event.target.value);
										setTouchedName(true);
									}}
									onBlur={() => setTouchedName(true)}
									placeholder={copy.namePlaceholder}
									autoComplete="off"
									spellCheck={false}
									disabled={props.busy}
									aria-invalid={touchedName && Boolean(nameError)}
								/>
							</label>
							<p className={touchedName && nameError ? "settings-status-error skills-field-note" : "skills-field-note"}>
								{touchedName && nameError ? nameError : copy.nameHint}
							</p>
						</>
					)}

					{!isCreate && (
						<p className="settings-path skills-editor-path">
							{copy.scopes[props.detail.scope]} · <code>{props.detail.filePath}</code>
						</p>
					)}

					<label>
						<span className="skills-label-row">
							<span>{copy.descriptionLabel}</span>
							<span className={trimmedDescription.length > SKILL_DESCRIPTION_MAX_LENGTH ? "skills-char-count is-over" : "skills-char-count"}>
								{trimmedDescription.length}/{SKILL_DESCRIPTION_MAX_LENGTH}
							</span>
						</span>
						<textarea
							value={description}
							onChange={(event) => {
								setDescription(event.target.value);
								setTouchedDescription(true);
							}}
							onBlur={() => setTouchedDescription(true)}
							placeholder={copy.descriptionPlaceholder}
							rows={2}
							disabled={props.busy}
							aria-invalid={touchedDescription && Boolean(descriptionError)}
						/>
					</label>
					{touchedDescription && descriptionError && (
						<p className="settings-status-error skills-field-note">{descriptionError}</p>
					)}

					<label className="skills-body-label">
						{copy.bodyLabel}
						<textarea
							className="skills-body-textarea"
							value={content}
							onChange={(event) => setContent(event.target.value)}
							placeholder={copy.bodyPlaceholder}
							spellCheck={false}
							rows={10}
							disabled={props.busy}
						/>
					</label>

					{!isCreate && props.detail.supportingFiles.length > 0 && (
						<details className="settings-advanced">
							<summary>
								{copy.supportingFilesHeading} ({props.detail.supportingFiles.length})
							</summary>
							<div className="settings-advanced-body skills-supporting-body">
								<p className="skills-field-note">{copy.supportingFilesNote}</p>
								<ul className="skills-supporting-list">
									{props.detail.supportingFiles.map((file) => (
										<li key={file}><code>{file}</code></li>
									))}
								</ul>
							</div>
						</details>
					)}
				</section>
			</div>

			<div className="settings-actions settings-dialog-actions">
				<button type="button" disabled={props.busy} onClick={props.onCancel}>
					{copy.cancel}
				</button>
				<button className="primary-button" type="submit" disabled={!canSubmit}>
					{isCreate ? copy.create : copy.save}
				</button>
			</div>
		</form>
	);
}
