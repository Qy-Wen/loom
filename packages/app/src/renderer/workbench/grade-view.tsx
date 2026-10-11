import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	FULL_IMAGE_CROP,
	IDENTITY_IMAGE_GRADE,
	adjustCrop,
	flipCrop,
	isGradeableVideo,
	isNeutralImageGrade,
	normalizeImageGrade,
	rotateCrop,
	type CropHandle,
	type CurvePoint,
	type ImageCrop,
	type ImageGrade,
	type ImageRotation,
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
	actions = null,
}: {
	asset: Asset;
	assets: Asset[];
	onGraded?: (assetId: string) => void;
	panelHost: HTMLElement | null;
	actions?: ReactNode;
}): React.JSX.Element {
	const { t } = useLocale();
	const [grade, setGrade] = useState<ImageGrade>(IDENTITY_IMAGE_GRADE);
	const [sourceId, setSourceId] = useState(asset.assetId);
	const [lut, setLut] = useState<string | undefined>();
	const [channel, setChannel] = useState<CurveChannel>("rgb");
	const [dirty, setDirty] = useState(false);
	const [comparing, setComparing] = useState(false);
	const [cropping, setCropping] = useState(false);
	const [saving, setSaving] = useState<"save" | "saveAs" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [proxyUrl, setProxyUrl] = useState<string | null>(null);
	const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [loadingFrame, setLoadingFrame] = useState(() => asset.type === "video" && isGradeableVideo(asset.filename));
	const dirtyRef = useRef(false);
	const proxyRef = useRef<string | null>(null);
	const fallbackRef = useRef<string | null>(null);
	const triedFallback = useRef(false);
	fallbackRef.current = fallbackUrl;

	const source = assets.find((item) => item.assetId === sourceId) ?? asset;
	const video = source.type === "video" && isGradeableVideo(source.filename);
	const neutral = isNeutralImageGrade(grade) && !lut;
	const showOriginal = comparing || neutral;
	const shownUrl = video
		? proxyUrl
		: showOriginal ? (fallbackUrl ?? assetPreviewUrl(source)) : (proxyUrl ?? fallbackUrl ?? assetPreviewUrl(source));

	useEffect(() => {
		dirtyRef.current = false;
		setDirty(false);
		setGrade(IDENTITY_IMAGE_GRADE);
		setSourceId(asset.assetId);
		setLut(undefined);
		setChannel("rgb");
		setError(null);
		setComparing(false);
		setCropping(false);
		setTime(0);
		setDuration(0);
		setLoadingFrame(asset.type === "video" && isGradeableVideo(asset.filename));
		triedFallback.current = false;
		setFallbackUrl((current) => {
			if (current) URL.revokeObjectURL(current);
			return null;
		});
	}, [asset.assetId]);

	useEffect(() => {
		if (!video) return;
		let cancelled = false;
		void window.loom.getVideoGradeInfo(asset.assetId).then((info) => {
			if (!cancelled) setDuration(Math.max(0, info.duration));
		}).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [asset.assetId, video]);

	const liveRef = useRef({ sourceId, grade, lut, showOriginal, cropping, video, time, previewFailed: t.grade.previewFailed });
	liveRef.current = { sourceId, grade, lut, showOriginal, cropping, video, time, previewFailed: t.grade.previewFailed };
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
					if (!shot.video && shot.showOriginal) return;
					if (shot.video && !proxyRef.current) setLoadingFrame(true);
					const key = previewKey(shot);
					try {
						const previewGrade = shot.cropping ? { ...shot.grade, crop: FULL_IMAGE_CROP } : shot.grade;
						const bytes = shot.video
							? await window.loom.previewVideoGrade(
								shot.sourceId,
								shot.time,
								shot.showOriginal ? IDENTITY_IMAGE_GRADE : previewGrade,
								shot.showOriginal ? undefined : shot.lut,
								shot.showOriginal,
							)
							: await window.loom.previewImageGrade(shot.sourceId, previewGrade, shot.lut);
						if (stopped || liveRef.current.sourceId !== shot.sourceId) return;
						if (!shot.video && liveRef.current.showOriginal) return;
						if (previewKey(liveRef.current) !== key) continue;
						setProxyUrl(replaceBlob(proxyRef, bytes));
						if (shot.video) setLoadingFrame(false);
						if (bytes) setError(null);
						return;
					} catch (cause) {
						if (!stopped) {
							if (shot.video) setLoadingFrame(false);
							setError(cause instanceof Error ? cause.message : shot.previewFailed);
						}
						return;
					}
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

	const previewSignature = previewKey({ sourceId, grade, lut, cropping, video, time, showOriginal });
	useEffect(() => {
		drainRef.current();
	}, [previewSignature, showOriginal]);

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

	function turn(direction: 1 | -1): void {
		const rotation = ((grade.rotation + direction + 4) % 4) as ImageRotation;
		edit({ ...grade, rotation, crop: rotateCrop(grade.crop, direction) });
	}

	function mirror(axis: "h" | "v"): void {
		edit({
			...grade,
			flipH: axis === "h" ? !grade.flipH : grade.flipH,
			flipV: axis === "v" ? !grade.flipV : grade.flipV,
			crop: flipCrop(grade.crop, axis),
		});
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
			const result = video
				? await window.loom.saveVideoGrade(sourceId, grade, lut, output)
				: await window.loom.saveImageGrade(sourceId, grade, lut, output);
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
	const showFrameLoading = video && loadingFrame && !shownUrl;

	return (
		<div className="grade-workbench">
			<div className="grade-stage">
				<div className="preview-stack">
					<div className={`grade-frame${showFrameLoading ? " is-loading" : ""}`}>
						{showFrameLoading && <p className="grade-loading">{t.grade.loading}</p>}
						{shownUrl ? (
							<img
								src={shownUrl}
								alt={asset.filename}
								onError={() => {
									if (video || triedFallback.current || !showOriginal) return;
									triedFallback.current = true;
									void window.loom.previewImageGrade(sourceId, IDENTITY_IMAGE_GRADE, undefined, true).then((bytes) => {
										if (bytes) setFallbackUrl(base64ToObjectUrl(bytes));
									}).catch(() => undefined);
								}}
							/>
						) : null}
						{cropping && !comparing && shownUrl && (
							<GradeCrop
								crop={grade.crop}
								moveLabel={t.grade.moveCrop}
								resizeLabel={t.grade.resizeCrop}
								onChange={(crop) => edit({ ...grade, crop })}
							/>
						)}
					</div>
					{video && (
						<label className="grade-time">
							<span>{formatClock(time)}</span>
							<input
								type="range"
								min={0}
								max={duration > 0 ? duration : 0}
								step={duration > 0 ? Math.min(0.05, duration) : 1}
								value={Math.min(time, duration > 0 ? duration : 0)}
								aria-label={t.grade.time}
								disabled={duration <= 0}
								onChange={(event) => setTime(Number(event.target.value))}
							/>
							<span>{formatClock(duration)}</span>
						</label>
					)}
					{actions}
				</div>
			</div>
			{panelHost && createPortal(<div className="grade-panel thin-scroll">
				<div className="grade-geometry">
					<button type="button" title={t.grade.rotateLeft} aria-label={t.grade.rotateLeft} disabled={saving !== null} onClick={() => turn(-1)}>
						<RotateLeftIcon />
					</button>
					<button type="button" title={t.grade.rotateRight} aria-label={t.grade.rotateRight} disabled={saving !== null} onClick={() => turn(1)}>
						<RotateRightIcon />
					</button>
					<button type="button" title={t.grade.flipHorizontal} aria-label={t.grade.flipHorizontal} aria-pressed={grade.flipH} disabled={saving !== null} onClick={() => mirror("h")}>
						<FlipHorizontalIcon />
					</button>
					<button type="button" title={t.grade.flipVertical} aria-label={t.grade.flipVertical} aria-pressed={grade.flipV} disabled={saving !== null} onClick={() => mirror("v")}>
						<FlipVerticalIcon />
					</button>
					<button type="button" className="grade-crop-toggle" title={t.grade.crop} aria-label={t.grade.crop} aria-pressed={cropping} disabled={saving !== null} onClick={() => setCropping((on) => !on)}>
						<CropIcon />
					</button>
				</div>
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

function previewKey(shot: { sourceId: string; grade: ImageGrade; lut?: string; cropping: boolean; video?: boolean; time?: number; showOriginal?: boolean }): string {
	const base = JSON.stringify([shot.sourceId, shot.lut ?? "", shot.cropping, { ...shot.grade, crop: shot.cropping ? undefined : shot.grade.crop }]);
	if (!shot.video) return base;
	const time = Math.round((shot.time ?? 0) * 1000) / 1000;
	return `${base}|${time}|${shot.showOriginal ? 1 : 0}`;
}

function formatClock(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function replaceBlob(slot: React.MutableRefObject<string | null>, bytes: string | null): string | null {
	if (slot.current) URL.revokeObjectURL(slot.current);
	slot.current = bytes ? base64ToObjectUrl(bytes) : null;
	return slot.current;
}

const CROP_HANDLES: Array<Exclude<CropHandle, "move">> = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function GradeCrop({
	crop,
	moveLabel,
	resizeLabel,
	onChange,
}: {
	crop: ImageCrop;
	moveLabel: string;
	resizeLabel: string;
	onChange: (crop: ImageCrop) => void;
}): React.JSX.Element {
	const right = 1 - crop.x - crop.w;
	const bottom = 1 - crop.y - crop.h;
	const dragRef = useRef<(() => void) | null>(null);
	useEffect(() => () => dragRef.current?.(), []);
	function start(event: React.PointerEvent, handle: CropHandle): void {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const frame = event.currentTarget.closest(".grade-frame")?.getBoundingClientRect();
		if (!frame || frame.width < 1 || frame.height < 1) return;
		const bounds = frame;
		dragRef.current?.();
		const origin = crop;
		const startX = event.clientX;
		const startY = event.clientY;
		function move(ev: PointerEvent): void {
			const dx = (ev.clientX - startX) / bounds.width;
			const dy = (ev.clientY - startY) / bounds.height;
			if (dx === 0 && dy === 0) return;
			onChange(adjustCrop(origin, handle, dx, dy));
		}
		function end(): void {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			if (dragRef.current === end) dragRef.current = null;
		}
		dragRef.current = end;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
	}

	return (
		<>
			{crop.y > 0 && <div className="grade-shade" style={{ top: 0, left: 0, right: 0, height: pct(crop.y) }} />}
			{bottom > 0 && <div className="grade-shade" style={{ bottom: 0, left: 0, right: 0, height: pct(bottom) }} />}
			{crop.x > 0 && <div className="grade-shade" style={{ top: pct(crop.y), left: 0, width: pct(crop.x), height: pct(crop.h) }} />}
			{right > 0 && <div className="grade-shade" style={{ top: pct(crop.y), right: 0, width: pct(right), height: pct(crop.h) }} />}
			<div
				className="grade-crop"
				role="group"
				aria-label={moveLabel}
				style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }}
				onPointerDown={(event) => start(event, "move")}
			>
				{CROP_HANDLES.map((handle) => (
					<button
						key={handle}
						type="button"
						className={`grade-crop-handle ${handle}`}
						aria-label={resizeLabel}
						onPointerDown={(event) => start(event, handle)}
					/>
				))}
			</div>
		</>
	);
}

function pct(value: number): string {
	return `${value * 100}%`;
}

function RotateLeftIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M3.2 7.2A4.8 4.8 0 1 1 4.6 11" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M3 3.8v3.6h3.6" />
		</svg>
	);
}

function RotateRightIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M12.8 7.2A4.8 4.8 0 1 0 11.4 11" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M13 3.8v3.6H9.4" />
		</svg>
	);
}

function FlipHorizontalIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" d="M2.2 12.6 7.2 3.4v9.2H2.2zM13.8 12.6 8.8 3.4v9.2h5z" />
		</svg>
	);
}

function CropIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M5.2 2.2v8.6h8.6M10.8 13.8V5.2H2.2" />
		</svg>
	);
}

function FlipVerticalIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" d="M3.4 2.2 12.6 7.2H3.4V2.2zM3.4 13.8 12.6 8.8H3.4v5z" />
		</svg>
	);
}

function base64ToObjectUrl(bytes: string): string {
	const binary = atob(bytes);
	const buffer = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) buffer[index] = binary.charCodeAt(index);
	return URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
}
