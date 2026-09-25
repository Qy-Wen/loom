import { useEffect, useState } from "react";
import { MODEL_SLOTS, type ModelSettingsDraft, type ModelSlotId } from "../../shared/model-settings.ts";

const SLOT_LABELS: Record<ModelSlotId, { title: string; hint: string; keyHint: string }> = {
	chat: {
		title: "Chat",
		hint: "Agent loop. OpenAI-compatible POST /v1/chat/completions.",
		keyHint: "needed for llm chat",
	},
	embedding: {
		title: "Embedding",
		hint: "Text RAG. OpenAI-compatible POST /v1/embeddings.",
		keyHint: "optional",
	},
	rerank: {
		title: "Rerank",
		hint: "Later retrieve. Cohere/Jina POST /v1/rerank. Slot is optional.",
		keyHint: "optional",
	},
	vlm: {
		title: "VLM",
		hint: "Later Level 3. Chat completions plus image_url. Slot is optional.",
		keyHint: "optional",
	},
};

const HIDDEN_KEYS: Record<ModelSlotId, boolean> = {
	chat: true,
	embedding: true,
	rerank: true,
	vlm: true,
};

interface SettingsPageProps {
	onClose: () => void;
}

function EyeIcon({ open }: { open: boolean }): React.JSX.Element {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			{open ? (
				<>
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
						d="M3 3l18 18"
					/>
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M10.6 10.7a2.2 2.2 0 0 0 3 3M9.5 5.6A10.4 10.4 0 0 1 12 5.3c5.2 0 8.8 4.2 9.7 6.7a1 1 0 0 1 0 .7 12 12 0 0 1-4.2 5.1M6.2 6.4A12 12 0 0 0 2.3 12.3a1 1 0 0 0 0 .7C3.2 15.5 6.8 19.7 12 19.7c1.5 0 2.8-.3 4-.8"
					/>
				</>
			) : (
				<>
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinejoin="round"
						d="M2.3 12.3a1 1 0 0 1 0-.6C3.2 8.5 6.8 4.3 12 4.3s8.8 4.2 9.7 7.4a1 1 0 0 1 0 .6C20.8 15.5 17.2 19.7 12 19.7S3.2 15.5 2.3 12.3Z"
					/>
					<circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
				</>
			)}
		</svg>
	);
}

export function SettingsPage({ onClose }: SettingsPageProps): React.JSX.Element {
	const [draft, setDraft] = useState<ModelSettingsDraft | null>(null);
	const [hidden, setHidden] = useState(HIDDEN_KEYS);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		function onKey(event: KeyboardEvent): void {
			if (event.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		void window.loom.getModelSettings().then((view) => {
			setDraft({
				chat: { baseUrl: view.chat.baseUrl, model: view.chat.model, apiKey: view.chat.apiKey },
				embedding: { baseUrl: view.embedding.baseUrl, model: view.embedding.model, apiKey: view.embedding.apiKey },
				rerank: { baseUrl: view.rerank.baseUrl, model: view.rerank.model, apiKey: view.rerank.apiKey },
				vlm: { baseUrl: view.vlm.baseUrl, model: view.vlm.model, apiKey: view.vlm.apiKey },
			});
		}).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
		});
	}, []);

	function patch(id: ModelSlotId, field: "baseUrl" | "model" | "apiKey", value: string): void {
		setDraft((current) => current ? { ...current, [id]: { ...current[id], [field]: value } } : current);
	}

	async function save(): Promise<void> {
		if (!draft) return;
		setSaving(true);
		setError(null);
		try {
			await window.loom.saveModelSettings(draft);
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="settings-overlay" role="presentation" onClick={onClose}>
			<div
				className="settings-dialog"
				role="dialog"
				aria-labelledby="settings-title"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="settings-header">
					<h2 id="settings-title">Settings</h2>
					<button className="icon-button" type="button" onClick={onClose} aria-label="Close settings">×</button>
				</div>
				<p className="settings-lead">
					Local or remote is the same form: URL, API key, and model. Hosted APIs need a key; local servers often do not. Keys stay in the app, not in the library.
				</p>
				{error && <div className="session-error">{error}</div>}
				{!draft ? (
					<div className="empty">Loading…</div>
				) : (
					<form
						className="settings-form"
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						{MODEL_SLOTS.map((id) => (
							<fieldset key={id} className="settings-slot">
								<legend>{SLOT_LABELS[id].title}</legend>
								<p>{SLOT_LABELS[id].hint}</p>
								<label>
									Base URL
									<input
										value={draft[id].baseUrl}
										onChange={(event) => patch(id, "baseUrl", event.target.value)}
										placeholder="https://api.example.com"
										autoComplete="off"
									/>
								</label>
								<label>
									Model
									<input
										value={draft[id].model}
										onChange={(event) => patch(id, "model", event.target.value)}
										placeholder="model id"
										autoComplete="off"
									/>
								</label>
								<div className="settings-secret">
									<span>API key</span>
									<div className="settings-secret-row">
										<input
											type={hidden[id] ? "password" : "text"}
											value={draft[id].apiKey ?? ""}
											onChange={(event) => patch(id, "apiKey", event.target.value)}
											placeholder={SLOT_LABELS[id].keyHint}
											autoComplete="off"
											aria-label={`${SLOT_LABELS[id].title} API key`}
										/>
										<button
											className="settings-reveal"
											type="button"
											aria-label={hidden[id] ? `Show ${SLOT_LABELS[id].title} API key` : `Hide ${SLOT_LABELS[id].title} API key`}
											onClick={() => setHidden((current) => ({ ...current, [id]: !current[id] }))}
										>
											<EyeIcon open={!hidden[id]} />
										</button>
									</div>
								</div>
							</fieldset>
						))}
						<div className="settings-actions">
							<button type="button" onClick={onClose}>Cancel</button>
							<button className="primary-button" type="submit" disabled={saving}>
								{saving ? "Saving…" : "Save"}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
