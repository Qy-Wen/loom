import { useEffect, useRef, useState } from "react";
import { MODEL_SLOTS, type ModelSettingsDraft, type ModelSlotDraft, type ModelSlotId } from "../../shared/model-settings.ts";
import { SettingsSwitch, type ProbeState } from "./settings-switch.tsx";

const SLOT_LABELS: Record<ModelSlotId, { title: string; hint: string; keyHint: string }> = {
	chat: {
		title: "Chat",
		hint: "Agent loop. OpenAI-compatible POST /v1/chat/completions.",
		keyHint: "needed for llm chat",
	},
	embedding: {
		title: "Text embedding",
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
		hint: "Image captions. OpenAI-compatible POST /v1/chat/completions with image_url. Slot is optional.",
		keyHint: "optional",
	},
};

const HIDDEN_KEYS: Record<ModelSlotId, boolean> = {
	chat: true,
	embedding: true,
	rerank: true,
	vlm: true,
};

const IDLE: Record<ModelSlotId, { state: ProbeState; error?: string }> = {
	chat: { state: "idle" },
	embedding: { state: "idle" },
	rerank: { state: "idle" },
	vlm: { state: "idle" },
};

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

interface SettingsModelsProps {
	draft: ModelSettingsDraft;
	onChange: (id: ModelSlotId, patch: Partial<ModelSlotDraft>) => void;
}

export function SettingsModels({ draft, onChange }: SettingsModelsProps): React.JSX.Element {
	const [hidden, setHidden] = useState(HIDDEN_KEYS);
	const [probes, setProbes] = useState(IDLE);
	const generation = useRef<Record<ModelSlotId, number>>({ chat: 0, embedding: 0, rerank: 0, vlm: 0 });
	const debounce = useRef<Partial<Record<ModelSlotId, number>>>({});
	const draftRef = useRef(draft);
	draftRef.current = draft;

	async function runProbe(id: ModelSlotId, slot: ModelSlotDraft): Promise<void> {
		const token = generation.current[id] + 1;
		generation.current[id] = token;
		setProbes((current) => ({ ...current, [id]: { state: "checking" } }));
		const result = await window.loom.probeModelSlot({
			slot: id,
			baseUrl: slot.baseUrl,
			model: slot.model,
			apiKey: slot.apiKey,
		});
		if (generation.current[id] !== token) return;
		setProbes((current) => ({
			...current,
			[id]: result.ok ? { state: "ok" } : { state: "error", error: result.error },
		}));
	}

	function clearTimer(id: ModelSlotId): void {
		const timer = debounce.current[id];
		if (timer !== undefined) window.clearTimeout(timer);
		debounce.current[id] = undefined;
	}

	useEffect(() => {
		for (const id of MODEL_SLOTS) {
			if (draft[id].enabled) void runProbe(id, draft[id]);
		}
		return () => {
			for (const id of MODEL_SLOTS) {
				generation.current[id] += 1;
				clearTimer(id);
			}
		};
		// Probe saved-on slots once when the form mounts.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function patchField(id: ModelSlotId, field: "baseUrl" | "model" | "apiKey", value: string): void {
		const next = { ...draftRef.current[id], [field]: value };
		draftRef.current = { ...draftRef.current, [id]: next };
		onChange(id, { [field]: value });
		if (!next.enabled) return;
		clearTimer(id);
		debounce.current[id] = window.setTimeout(() => {
			void runProbe(id, draftRef.current[id]);
		}, 500);
	}

	function patchEnabled(id: ModelSlotId, enabled: boolean): void {
		const next = { ...draftRef.current[id], enabled };
		draftRef.current = { ...draftRef.current, [id]: next };
		onChange(id, { enabled });
		clearTimer(id);
		if (!enabled) {
			generation.current[id] += 1;
			setProbes((current) => ({ ...current, [id]: { state: "idle" } }));
			return;
		}
		void runProbe(id, next);
	}

	return (
		<div className="settings-form settings-form-docked">
			<div className="settings-form-scroll">
			{MODEL_SLOTS.map((id) => (
				<fieldset key={id} className="settings-slot" aria-label={SLOT_LABELS[id].title}>
					<div className="settings-slot-head">
						<span className="settings-slot-title">{SLOT_LABELS[id].title}</span>
						<SettingsSwitch
							checked={draft[id].enabled}
							label={`Enable ${SLOT_LABELS[id].title}`}
							status={probes[id].state}
							error={probes[id].error}
							onChange={(enabled) => patchEnabled(id, enabled)}
						/>
					</div>
					<p>{SLOT_LABELS[id].hint}</p>
					<label>
						Base URL
						<input
							value={draft[id].baseUrl}
							onChange={(event) => patchField(id, "baseUrl", event.target.value)}
							placeholder="https://api.example.com"
							autoComplete="off"
						/>
					</label>
					<label>
						Model
						<input
							value={draft[id].model}
							onChange={(event) => patchField(id, "model", event.target.value)}
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
								onChange={(event) => patchField(id, "apiKey", event.target.value)}
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
					{probes[id].state === "ok" && (
						<p className="settings-status-ok">Connected</p>
					)}
					{probes[id].state === "checking" && (
						<p className="settings-path">Checking…</p>
					)}
				</fieldset>
			))}
			</div>
		</div>
	);
}
