import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	IDENTITY_IMAGE_GRADE,
	isNeutralImageGrade,
	normalizeImageGrade,
	type CurvePoint,
	type ImageGrade,
} from "@loom/core/grade";
import type { Asset } from "@loom/core";
import { assetPreviewUrl } from "../assets/asset-utils.ts";
import { useLocale } from "../locale.tsx";
import { GradeCurve } from "./grade-curve.tsx";

type CurveChannel = "rgb" | "r" | "g" | "b";

const CHANNELS: Array<{ id: CurveChannel; color: string }> = [
	{ id: "rgb", color: "#202124" },
	{ id: "r", color: "#c4453c" },
	{ id: "g", color: "#2f8f4e" },
	{ id: "b", color: "#2f62b5" },
];

export function GradeView({
	asset,
	assets,
	onGraded,
	panelHost,
}: {
	asset: Asset;
	assets: Asset[];
	onGraded?: (assetId: string) => void;
	panelHost: HTMLElement | null;
}): React.JSX.Element {
	const { t } = useLocale();
	const [grade, setGrade] = useState<ImageGrade>(IDENTITY_IMAGE_GRADE);
	const [sourceId, setSourceId] = useState(asset.assetId);
	const [lut, setLut] = useState<string | undefined>();
	const [channel, setChannel] = useState<CurveChannel>("rgb");
	const [dirty, setDirty] = useState(false);
	const [comparing, setComparing] = useState(false);
	const [saving, setSaving] = useState<"save" | "saveAs" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [proxyUrl, setProxyUrl] = useState<string | null>(null);
	const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
	const dirtyRef = useRef(false);
	const proxyRef = useRef<string | null>(null);
	const fallbackRef = useRef<string | null>(null);
	const assetsRef = useRef(assets);
	const triedFallback = useRef(false);
	assetsRef.current = assets;
	fallbackRef.current = fallbackUrl;

	const source = assets.find((item) => item.assetId === sourceId) ?? asset;
	const neutral = isNeutralImageGrade(grade) && !lut;
	const showOriginal = comparing || neutral;
	const shownUrl = showOriginal ? (fallbackUrl ?? assetPreviewUrl(source)) : (proxyUrl ?? fallbackUrl ?? assetPreviewUrl(source));

	useEffect(() => {
		let cancelled = false;
		dirtyRef.current = false;
		setDirty(false);
		setGrade(IDENTITY_IMAGE_GRADE);
		setSourceId(asset.assetId);
		setLut(undefined);
		setChannel("rgb");
		setError(null);
		setComparing(false);
		triedFallback.current = false;
		setFallbackUrl((current) => {
			if (current) URL.revokeObjectURL(current);
			return null;
		});
		void window.loom.getImageGrade(asset.assetId).then((record) => {
			if (cancelled || dirtyRef.current || !record?.sourceAssetId) return;
			const linked = assetsRef.current.find((item) => item.assetId === record.sourceAssetId);
			if (!linked) return;
			setSourceId(linked.assetId);
			setGrade(normalizeImageGrade(record.grade));
			setLut(record.lut);
		}).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [asset.assetId]);

	const liveRef = useRef({ sourceId, grade, lut, showOriginal, previewFailed: t.grade.previewFailed });
	liveRef.current = { sourceId, grade, lut, showOriginal, previewFailed: t.grade.previewFailed };
	const drainRef = useRef<() => void>(() => undefined);

	useEffect(() => {
		let stopped = false;
		let busy = false;

		async function drain(): Promise<void> {
			if (stopped || busy) return;
			busy = true;
			try {
				while (!stopped) {
					const shot = liveRef.current;
					if (shot.showOriginal) return;
					const key = previewKey(shot.sourceId, shot.grade, shot.lut);
					try {
						const bytes = await window.loom.previewImageGrade(shot.sourceId, shot.grade, shot.lut);
						if (stopped || liveRef.current.sourceId !== shot.sourceId) return;
						if (bytes) {
							setProxyUrl(replaceBlob(proxyRef, bytes));
							setError(null);
						}
					} catch (cause) {
						if (!stopped) setError(cause instanceof Error ? cause.message : shot.previewFailed);
						return;
					}
					if (stopped || liveRef.current.showOriginal) return;
					if (previewKey(liveRef.current.sourceId, liveRef.current.grade, liveRef.current.lut) === key) return;
				}
			} finally {
				busy = false;
			}
		}

		drainRef.current = () => {
			if (!stopped) void drain();
		};
		void drain();
		return () => {
			stopped = true;
			drainRef.current = () => undefined;
		};
	}, [sourceId]);

	useEffect(() => {
		drainRef.current();
	}, [grade, lut, showOriginal]);

	useEffect(() => () => {
		if (proxyRef.current) URL.revokeObjectURL(proxyRef.current);
		if (fallbackRef.current) URL.revokeObjectURL(fallbackRef.current);
	}, []);

	function edit(next: ImageGrade): void {
		dirtyRef.current = true;
		setDirty(true);
		setGrade(normalizeImageGrade(next));
	}

	function editCurve(points: CurvePoint[]): void {
		edit({ ...grade, curves: { ...grade.curves, [channel]: points } });
	}

	async function save(mode: "save" | "saveAs"): Promise<void> {
		setSaving(mode);
		setError(null);
		try {
			let output: string | undefined;
			if (mode === "saveAs") {
				const picked = await window.loom.pickGradeOutput(sourceId);
				if (!picked) return;
				output = picked;
			}
			const result = await window.loom.saveImageGrade(sourceId, grade, lut, output);
			dirtyRef.current = false;
			setDirty(false);
			onGraded?.(result.assetId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t.grade.saveFailed);
		} finally {
			setSaving(null);
		}
	}

	const channelLabel = {
		rgb: t.grade.curveRgb,
		r: t.grade.curveR,
		g: t.grade.curveG,
		b: t.grade.curveB,
	};
	const lutName = lut ? lut.split("/").at(-1) ?? lut : t.grade.none;

	return (
		<div className="grade-workbench">
			<div className="grade-stage">
				<img
					src={shownUrl}
					alt={asset.filename}
					onError={() => {
						if (triedFallback.current || !showOriginal) return;
						triedFallback.current = true;
						void window.loom.previewImageGrade(sourceId, IDENTITY_IMAGE_GRADE, undefined, true).then((bytes) => {
							if (bytes) setFallbackUrl(base64ToObjectUrl(bytes));
						}).catch(() => undefined);
					}}
				/>
			</div>
			{panelHost && createPortal(<div className="grade-panel">
				<GradeSlider label={t.grade.exposure} min={-3} max={3} step={0.01} value={grade.exposure} onChange={(exposure) => edit({ ...grade, exposure })} />
				<GradeSlider label={t.grade.brightness} min={-1} max={1} step={0.01} value={grade.brightness} onChange={(brightness) => edit({ ...grade, brightness })} />
				<GradeSlider label={t.grade.lightness} min={-1} max={1} step={0.01} value={grade.lightness} onChange={(lightness) => edit({ ...grade, lightness })} />
				<GradeSlider label={t.grade.hue} min={-180} max={180} step={1} value={grade.hue} onChange={(hue) => edit({ ...grade, hue })} />
				<GradeSlider label={t.grade.contrast} min={0} max={2} step={0.01} value={grade.contrast} onChange={(contrast) => edit({ ...grade, contrast })} />
				<GradeSlider label={t.grade.saturation} min={0} max={3} step={0.01} value={grade.saturation} onChange={(saturation) => edit({ ...grade, saturation })} />
				<GradeSlider label={t.grade.vibrance} min={-2} max={2} step={0.01} value={grade.vibrance} onChange={(vibrance) => edit({ ...grade, vibrance })} />
				<GradeSlider label={t.grade.temperature} min={1000} max={40000} step={50} value={grade.temperature} onChange={(temperature) => edit({ ...grade, temperature })} />
				<GradeSlider label={t.grade.black} min={0} max={1} step={0.01} value={grade.black} onChange={(black) => edit({ ...grade, black })} />
				<GradeSlider label={t.grade.white} min={0} max={1} step={0.01} value={grade.white} onChange={(white) => edit({ ...grade, white })} />
				<div className="grade-curves">
					<div className="grade-curves-head">
						<span>{t.grade.curves}</span>
						<div className="grade-curve-tabs">
							{CHANNELS.map((item) => (
								<button
									key={item.id}
									type="button"
									className={channel === item.id ? "active" : undefined}
									onClick={() => setChannel(item.id)}
								>
									{channelLabel[item.id]}
								</button>
							))}
						</div>
					</div>
					<GradeCurve
						points={grade.curves[channel]}
						color={CHANNELS.find((item) => item.id === channel)?.color ?? "#202124"}
						onChange={editCurve}
					/>
				</div>
				<div className="grade-lut">
					<span>{t.grade.lut}</span>
					<strong title={lut}>{lutName}</strong>
					<button type="button" className="open-button" onClick={() => {
						void window.loom.pickGradeLut().then((picked) => {
							if (!picked) return;
							dirtyRef.current = true;
							setDirty(true);
							setLut(picked.path);
						}).catch((cause: unknown) => {
							setError(cause instanceof Error ? cause.message : t.grade.previewFailed);
						});
					}}
					>
						{t.grade.importLut}
					</button>
					{lut && (
						<button type="button" className="open-button" onClick={() => {
							dirtyRef.current = true;
							setDirty(true);
							setLut(undefined);
						}}
						>
							{t.grade.clearLut}
						</button>
					)}
				</div>
				{error && <p className="grade-error">{error}</p>}
				<div className="grade-actions">
					<button
						type="button"
						className="open-button"
						onPointerDown={() => setComparing(true)}
						onPointerUp={() => setComparing(false)}
						onPointerLeave={() => setComparing(false)}
					>
						{t.grade.before}
					</button>
					<button type="button" className="open-button" onClick={() => {
						setLut(undefined);
						edit(IDENTITY_IMAGE_GRADE);
					}}
					>
						{t.grade.reset}
					</button>
					<button
						type="button"
						className="open-button"
						disabled={neutral || saving !== null}
						onClick={() => void save("saveAs")}
					>
						{saving === "saveAs" ? t.grade.saving : t.grade.saveAs}
					</button>
					<button
						type="button"
						className="primary-button"
						disabled={!dirty || neutral || saving !== null}
						onClick={() => void save("save")}
					>
						{saving === "save" ? t.grade.saving : t.grade.save}
					</button>
				</div>
			</div>, panelHost)}
		</div>
	);
}

function GradeSlider({
	label,
	min,
	max,
	step,
	value,
	onChange,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	onChange: (value: number) => void;
}): React.JSX.Element {
	const digits = step >= 1 ? 0 : 2;
	return (
		<label className="grade-field">
			<span>{label}</span>
			<span className="grade-field-value">{value.toFixed(digits)}</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
		</label>
	);
}

function previewKey(sourceId: string, grade: ImageGrade, lut?: string): string {
	return JSON.stringify([sourceId, lut ?? "", grade]);
}

function replaceBlob(slot: React.MutableRefObject<string | null>, bytes: string | null): string | null {
	if (slot.current) URL.revokeObjectURL(slot.current);
	slot.current = bytes ? base64ToObjectUrl(bytes) : null;
	return slot.current;
}

function base64ToObjectUrl(bytes: string): string {
	const binary = atob(bytes);
	const buffer = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) buffer[index] = binary.charCodeAt(index);
	return URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
}
