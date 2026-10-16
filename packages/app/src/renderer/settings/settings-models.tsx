import { useEffect, useRef, useState } from "react";
import { MODEL_REQUEST_PLACEHOLDERS, MODEL_SLOTS, type ModelSettingsDraft, type ModelSlotDraft, type ModelSlotId } from "../../shared/model-settings.ts";
import { useLocale } from "../locale.tsx";
import { SettingsSwitch, type ProbeState } from "./settings-switch.tsx";
import { SettingsApiKey } from "./settings-api-key.tsx";

interface SettingsModelsProps {
	draft: ModelSettingsDraft;
	onChange: (id: ModelSlotId, patch: Partial<ModelSlotDraft>) => void;
}

export function SettingsModels({ draft, onChange }: SettingsModelsProps): React.JSX.Element {
	const [probes, setProbes] = useState<Record<ModelSlotId, { state: ProbeState; error?: string }>>({ embedding: { state: "idle" }, rerank: { state: "idle" }, vlm: { state: "idle" }, audio: { state: "idle" } });
	const generation = useRef<Record<ModelSlotId, number>>({ embedding: 0, rerank: 0, vlm: 0, audio: 0 });
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

	const { t } = useLocale();
	return (
		<div className="settings-form settings-models-form">
			{MODEL_SLOTS.map((id) => (
				<fieldset key={id} className="settings-slot" aria-label={t.settings.slots[id].title}>
					<div className="settings-slot-head">
						<span className="settings-slot-title">{t.settings.slots[id].title}</span>
						<SettingsSwitch
							checked={draft[id].enabled}
							label={t.settings.enableSlot(t.settings.slots[id].title)}
							status={probes[id].state}
							error={probes[id].error}
							onChange={(enabled) => patchEnabled(id, enabled)}
						/>
					</div>
					<p>{t.settings.slots[id].hint}</p>
					<label>
						{t.settings.requestUrl}
						<input
							value={draft[id].baseUrl}
							onChange={(event) => patchField(id, "baseUrl", event.target.value)}
							placeholder={MODEL_REQUEST_PLACEHOLDERS[id]}
							autoComplete="off"
						/>
					</label>
					<label>
						{t.settings.model}
						<input
							value={draft[id].model}
							onChange={(event) => patchField(id, "model", event.target.value)}
							placeholder="model id"
							autoComplete="off"
						/>
					</label>
					<div className="settings-actions settings-model-key-actions">
						<SettingsApiKey
							label={t.settings.apiKeyOf(t.settings.slots[id].title)}
							value={draft[id].apiKey ?? ""}
							placeholder={t.settings.slots[id].keyHint}
							onConfirm={(key) => patchField(id, "apiKey", key)}
						/>
					</div>
					{probes[id].state === "ok" && (
						<p className="settings-status-ok">{t.settings.connected}</p>
					)}
					{probes[id].state === "checking" && (
						<p className="settings-path">{t.settings.checking}</p>
					)}
				</fieldset>
			))}
		</div>
	);
}
