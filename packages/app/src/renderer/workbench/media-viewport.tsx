import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useLocale } from "../locale.tsx";
import {
	FIT_MEDIA_VIEW,
	MAX_MEDIA_SCALE,
	MEDIA_ZOOM_STEP,
	MIN_MEDIA_SCALE,
	clampMediaView,
	cursorFromViewport,
	fittedMediaSize,
	hasMediaSize,
	maxMediaScale,
	mediaLayerTransform,
	panMedia,
	toggleMediaZoom,
	wheelZoomFactor,
	zoomMediaAt,
	type MediaSize,
	type MediaView,
} from "./media-zoom.ts";

const EMPTY_SIZE: MediaSize = { width: 0, height: 0 };
const ZOOM_CONTROLS_HIDE_DELAY = 1500;

function sameView(a: MediaView, b: MediaView): boolean {
	return a.scale === b.scale && a.x === b.x && a.y === b.y;
}

function sameSize(a: MediaSize, b: MediaSize): boolean {
	return Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function findMedia(root: ParentNode): HTMLImageElement | HTMLVideoElement | null {
	const node = root.querySelector("img, video");
	if (node instanceof HTMLImageElement || node instanceof HTMLVideoElement) return node;
	return null;
}

function naturalSize(node: HTMLImageElement | HTMLVideoElement): MediaSize {
	if (node instanceof HTMLVideoElement) return { width: node.videoWidth, height: node.videoHeight };
	return { width: node.naturalWidth, height: node.naturalHeight };
}

function viewportSize(viewport: HTMLElement): MediaSize {
	const rect = viewport.getBoundingClientRect();
	return { width: rect.width, height: rect.height };
}

function isZoomUi(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[data-zoom-ui]") !== null;
}

export function MediaViewport({
	assetId,
	kind,
	actions = null,
	children,
}: {
	assetId: string;
	kind: "image" | "video";
	actions?: ReactNode;
	children: ReactNode;
}): React.JSX.Element {
	const { t } = useLocale();
	const frameRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<MediaView>(FIT_MEDIA_VIEW);
	const fitRef = useRef<MediaSize>(EMPTY_SIZE);
	const maxRef = useRef(MAX_MEDIA_SCALE);
	const dragRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
	const zoomControlsTimerRef = useRef<number | null>(null);
	const [view, setView] = useState<MediaView>(FIT_MEDIA_VIEW);
	const [fit, setFit] = useState<MediaSize>(EMPTY_SIZE);
	const [maxScale, setMaxScale] = useState(MAX_MEDIA_SCALE);
	const [media, setMedia] = useState<HTMLImageElement | HTMLVideoElement | null>(null);
	const [panning, setPanning] = useState(false);
	const [zoomControlsVisible, setZoomControlsVisible] = useState(false);

	function commit(next: MediaView): void {
		viewRef.current = next;
		setView((current) => (sameView(current, next) ? current : next));
	}

	function commitZoom(next: MediaView): void {
		commit(next);
		setZoomControlsVisible(true);
		if (zoomControlsTimerRef.current !== null) window.clearTimeout(zoomControlsTimerRef.current);
		zoomControlsTimerRef.current = window.setTimeout(() => {
			zoomControlsTimerRef.current = null;
			setZoomControlsVisible(false);
		}, ZOOM_CONTROLS_HIDE_DELAY);
	}

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		viewRef.current = FIT_MEDIA_VIEW;
		fitRef.current = EMPTY_SIZE;
		maxRef.current = MAX_MEDIA_SCALE;
		setView(FIT_MEDIA_VIEW);
		setFit(EMPTY_SIZE);
		setMaxScale(MAX_MEDIA_SCALE);
		setZoomControlsVisible(false);

		const apply = () => {
			const node = findMedia(viewport);
			setMedia((current) => (current === node ? current : node));
			if (!node) return;
			const natural = naturalSize(node);
			if (!hasMediaSize(natural)) return;
			const room = viewportSize(viewport);
			if (!hasMediaSize(room)) return;
			const nextFit = fittedMediaSize(natural, room);
			const nextMax = maxMediaScale(natural, nextFit);
			fitRef.current = nextFit;
			maxRef.current = nextMax;
			setFit((current) => (sameSize(current, nextFit) ? current : nextFit));
			setMaxScale((current) => (Math.abs(current - nextMax) < 0.01 ? current : nextMax));
			if (!hasMediaSize(nextFit)) return;
			const nextView = clampMediaView(viewRef.current, room, nextFit, nextMax);
			if (!sameView(viewRef.current, nextView)) commit(nextView);
		};

		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(viewport);
		const preview = viewport.closest(".media-preview");
		if (preview instanceof HTMLElement) observer.observe(preview);
		viewport.addEventListener("load", apply, true);
		viewport.addEventListener("loadedmetadata", apply, true);
		return () => {
			if (zoomControlsTimerRef.current !== null) window.clearTimeout(zoomControlsTimerRef.current);
			zoomControlsTimerRef.current = null;
			observer.disconnect();
			viewport.removeEventListener("load", apply, true);
			viewport.removeEventListener("loadedmetadata", apply, true);
		};
	}, [assetId]);

	useEffect(() => {
		const frame = frameRef.current;
		const viewport = viewportRef.current;
		if (!frame || !viewport) return;
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY === 0) return;
			if (event.target instanceof Element && event.target.closest("[data-zoom-ui]")) return;
			if (!hasMediaSize(fitRef.current)) return;
			event.preventDefault();
			const rect = viewport.getBoundingClientRect();
			const cursor = cursorFromViewport(rect, event.clientX, event.clientY);
			const next = zoomMediaAt(
				viewRef.current,
				cursor,
				wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey),
				{ width: rect.width, height: rect.height },
				fitRef.current,
				maxRef.current,
			);
			commitZoom(next);
		};
		frame.addEventListener("wheel", onWheel, { passive: false });
		return () => frame.removeEventListener("wheel", onWheel);
	}, [assetId]);

	function zoomBy(factor: number): void {
		const viewport = viewportRef.current;
		if (!viewport || !hasMediaSize(fitRef.current)) return;
		const clip = viewportSize(viewport);
		commitZoom(zoomMediaAt(viewRef.current, { x: 0, y: 0 }, factor, clip, fitRef.current, maxRef.current));
	}

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
		if (event.button !== 0 || isZoomUi(event.target)) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
	}

	function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
		const drag = dragRef.current;
		if (!drag || drag.id !== event.pointerId) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) < 4) return;
		drag.moved = true;
		drag.x = event.clientX;
		drag.y = event.clientY;
		setPanning(true);
		const viewport = viewportRef.current;
		if (!viewport || !hasMediaSize(fitRef.current)) return;
		commit(panMedia(viewRef.current, { x: dx, y: dy }, viewportSize(viewport), fitRef.current));
	}

	function endDrag(event: ReactPointerEvent<HTMLDivElement>): void {
		if (dragRef.current?.id !== event.pointerId) return;
		dragRef.current = null;
		setPanning(false);
	}

	function onDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
		if (isZoomUi(event.target)) return;
		const viewport = viewportRef.current;
		if (!viewport || !hasMediaSize(fitRef.current)) return;
		const rect = viewport.getBoundingClientRect();
		commitZoom(toggleMediaZoom(
			viewRef.current,
			cursorFromViewport(rect, event.clientX, event.clientY),
			{ width: rect.width, height: rect.height },
			fitRef.current,
			maxRef.current,
		));
	}

	const fitted = hasMediaSize(fit);
	const video = kind === "video" && media instanceof HTMLVideoElement ? media : null;
	const percent = `${Math.round(view.scale * 100)}%`;

	return (
		<div className="media-stage">
			<div ref={frameRef} className={`media-frame${panning ? " is-panning" : ""}`}>
				<div
					ref={viewportRef}
					className="media-viewport"
					role="group"
					aria-label={t.preview.zoomHint}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					onLostPointerCapture={endDrag}
					onDoubleClick={onDoubleClick}
					onDragStart={(event) => event.preventDefault()}
				>
					<div
						className="media-zoom-layer"
						data-fitted={fitted ? "" : undefined}
						style={fitted ? { width: fit.width, height: fit.height, transform: mediaLayerTransform(view) } : undefined}
					>
						{children}
					</div>
				</div>
				<div className={`media-zoom-controls${zoomControlsVisible ? " is-visible" : ""}`} data-zoom-ui="">
					<button
						type="button"
						title={t.preview.zoomOut}
						aria-label={t.preview.zoomOut}
						disabled={!fitted || view.scale <= MIN_MEDIA_SCALE + 0.001}
						onClick={() => zoomBy(1 / MEDIA_ZOOM_STEP)}
					>
						<ZoomStepIcon />
					</button>
					<button type="button" className="media-zoom-percent" title={t.preview.resetZoom} aria-label={t.preview.resetZoom} onClick={() => commitZoom(FIT_MEDIA_VIEW)}>
						{percent}
					</button>
					<button
						type="button"
						title={t.preview.zoomIn}
						aria-label={t.preview.zoomIn}
						disabled={!fitted || view.scale >= maxScale - 0.001}
						onClick={() => zoomBy(MEDIA_ZOOM_STEP)}
					>
						<ZoomStepIcon increase />
					</button>
				</div>
				{video && <VideoTransport video={video} actions={actions} />}
			</div>
		</div>
	);
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function ZoomStepIcon({ increase = false }: { increase?: boolean }): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
			<path d="M3 8h10" />
			{increase && <path d="M8 3v10" />}
		</svg>
	);
}

function VideoTransport({ video, actions = null }: { video: HTMLVideoElement; actions?: ReactNode }): React.JSX.Element | null {
	const { t } = useLocale();
	const [clock, setClock] = useState(() => readVideo(video));

	useEffect(() => {
		const sync = () => setClock(readVideo(video));
		sync();
		const events = ["timeupdate", "durationchange", "play", "pause", "volumechange", "ratechange", "loadedmetadata", "emptied"] as const;
		for (const name of events) video.addEventListener(name, sync);
		const onFullscreen = () => sync();
		document.addEventListener("fullscreenchange", onFullscreen);
		return () => {
			for (const name of events) video.removeEventListener(name, sync);
			document.removeEventListener("fullscreenchange", onFullscreen);
		};
	}, [video]);

	if (!clock.ready) return null;
	const playLabel = clock.paused ? t.preview.play : t.preview.pause;
	const muteLabel = clock.muted || clock.volume === 0 ? t.preview.unmute : t.preview.mute;
	const fullscreenLabel = clock.fullscreen ? t.preview.exitFullscreen : t.preview.fullscreen;
	return (
		<div className={`media-transport${clock.paused ? " is-paused" : ""}`} data-zoom-ui="">
			<input
				className="media-seek"
				type="range"
				min={0}
				max={clock.duration > 0 ? clock.duration : 0}
				step={clock.duration > 0 ? Math.min(0.05, clock.duration) : 1}
				value={Math.min(clock.time, clock.duration > 0 ? clock.duration : 0)}
				aria-label={t.preview.seek}
				disabled={clock.duration <= 0}
				onChange={(event) => {
					video.currentTime = Number(event.target.value);
				}}
			/>
			<div className="media-transport-row">
				<div className="media-transport-group">
					<button
						type="button"
						title={playLabel}
						aria-label={playLabel}
						onClick={() => {
							if (video.paused) void video.play().catch(() => undefined);
							else video.pause();
						}}
					>
						{clock.paused ? <PlayIcon /> : <PauseIcon />}
					</button>
					<span className="media-clock">
						{formatClock(clock.time)}
						<span className="media-clock-sep"> / </span>
						{formatClock(clock.duration)}
					</span>
				</div>
				<div className="media-transport-center">
					{actions}
					<button
						type="button"
						className="preview-fullscreen"
						title={fullscreenLabel}
						aria-label={fullscreenLabel}
						aria-pressed={clock.fullscreen}
						onClick={() => { void toggleVideoFullscreen(video); }}
					>
						{clock.fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
					</button>
				</div>
				<div className="media-transport-group">
					<button type="button" title={muteLabel} aria-label={muteLabel} onClick={() => { video.muted = !video.muted; }}>
						{clock.muted || clock.volume === 0 ? <MutedIcon /> : <VolumeIcon />}
					</button>
					<input
						className="media-volume"
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={clock.muted ? 0 : clock.volume}
						aria-label={t.preview.volume}
						onChange={(event) => {
							const next = Number(event.target.value);
							video.volume = next;
							video.muted = next === 0;
						}}
					/>
					<SpeedControl
						rate={clock.rate}
						onChange={(rate) => {
							video.playbackRate = rate;
						}}
					/>
				</div>
			</div>
		</div>
	);
}

function readVideo(video: HTMLVideoElement): { time: number; duration: number; paused: boolean; muted: boolean; volume: number; rate: number; fullscreen: boolean; ready: boolean } {
	return {
		time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
		duration: Number.isFinite(video.duration) ? video.duration : 0,
		paused: video.paused,
		muted: video.muted,
		volume: Number.isFinite(video.volume) ? video.volume : 1,
		rate: Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1,
		fullscreen: document.fullscreenElement === video.closest(".media-stage"),
		ready: video.readyState >= 1,
	};
}

function toggleVideoFullscreen(video: HTMLVideoElement): Promise<void> {
	const preview = video.closest(".media-stage");
	if (!(preview instanceof HTMLElement)) return Promise.resolve();
	const request = document.fullscreenElement === preview ? document.exitFullscreen() : preview.requestFullscreen();
	return request.catch(() => undefined);
}

export function MediaFullscreenButton(): React.JSX.Element {
	const { t } = useLocale();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [active, setActive] = useState(false);

	useEffect(() => {
		const sync = () => setActive(document.fullscreenElement === buttonRef.current?.closest(".media-preview"));
		document.addEventListener("fullscreenchange", sync);
		return () => document.removeEventListener("fullscreenchange", sync);
	}, []);

	const label = active ? t.preview.exitFullscreen : t.preview.fullscreen;
	return (
		<button
			ref={buttonRef}
			type="button"
			className="preview-fullscreen"
			title={label}
			aria-label={label}
			aria-pressed={active}
			onClick={() => {
				const preview = buttonRef.current?.closest(".media-preview");
				if (!(preview instanceof HTMLElement)) return;
				const request = document.fullscreenElement === preview ? document.exitFullscreen() : preview.requestFullscreen();
				void request.catch(() => undefined);
			}}
		>
			{active ? <ExitFullscreenIcon /> : <FullscreenIcon />}
		</button>
	);
}

function SpeedControl({ rate, onChange }: { rate: number; onChange: (rate: number) => void }): React.JSX.Element {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div ref={rootRef} className="media-speed" onMouseLeave={() => setOpen(false)}>
			<button
				type="button"
				title={t.preview.speed}
				aria-label={t.preview.speed}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				{formatSpeed(rate)}
			</button>
			{open && (
				<div className="media-speed-menu" role="listbox" aria-label={t.preview.speed}>
					{[...PLAYBACK_RATES].reverse().map((item) => (
						<button
							key={item}
							type="button"
							role="option"
							aria-selected={Math.abs(item - rate) < 0.01}
							onClick={() => {
								onChange(item);
								setOpen(false);
							}}
						>
							{formatSpeed(item)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function formatSpeed(rate: number): string {
	return `${rate}×`;
}

function formatClock(seconds: number): string {
	const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = total % 60;
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function PlayIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M5.2 3.3v9.4L12.6 8 5.2 3.3z" />
		</svg>
	);
}

function PauseIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M4.2 3.2h2.4v9.6H4.2zM9.4 3.2h2.4v9.6H9.4z" />
		</svg>
	);
}

function VolumeIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M3 6.2h2.1L8.2 3.5v9L5.1 9.8H3V6.2z" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="M10.2 6.1a2.7 2.7 0 0 1 0 3.8" />
		</svg>
	);
}

function MutedIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="currentColor" d="M3 6.2h2.1L8.2 3.5v9L5.1 9.8H3V6.2z" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="m10.2 6.4 3.2 3.2M13.4 6.4l-3.2 3.2" />
		</svg>
	);
}

function FullscreenIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M6.2 3.2H3.2v3M9.8 3.2h3v3M12.8 9.8v3h-3M6.2 12.8h-3v-3" />
		</svg>
	);
}

function ExitFullscreenIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M3.2 6.2h3v-3M12.8 6.2h-3v-3M9.8 12.8v-3h3M6.2 12.8v-3h-3" />
		</svg>
	);
}
