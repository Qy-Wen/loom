import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import type { Asset } from "@loom/core";
import { AssetThumbnail } from "../../assets/asset-thumbnail.tsx";
import { assetPreviewUrl, assetWaveformUrl } from "../../assets/asset-utils.ts";
import { formatClock, MutedIcon, PlaybackIcon, VolumeIcon } from "../../components/media-controls.tsx";
import { useLocale } from "../../locale.tsx";

export type CanvasPlayback = {
	boardId: string;
	positions: Map<string, number>;
	activate: (media: HTMLMediaElement) => void;
};

function readWaveformPeaks(image: HTMLImageElement): number[] {
	const { naturalWidth: width, naturalHeight: height } = image;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context || !width || !height) return [];

	context.drawImage(image, 0, 0);
	const { data } = context.getImageData(0, 0, width, height);
	const peaks = Array<number>(Math.min(width, 64)).fill(0);
	for (let x = 0; x < width; x++) {
		// The opacity in each column encodes the height of the source waveform.
		let opacity = 0;
		for (let y = 0; y < height; y++) opacity += data[(y * width + x) * 4 + 3]!;
		const bar = Math.floor(x * peaks.length / width);
		peaks[bar] = Math.max(peaks[bar]!, opacity / (255 * height));
	}
	return peaks;
}

export function CanvasMedia({ asset, nodeId, playback, disabled, onSize }: {
	asset: Asset;
	nodeId: string;
	playback: CanvasPlayback;
	disabled: boolean;
	onSize: (width: number, height: number) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const video = asset.type === "video";
	const src = assetPreviewUrl(asset);
	const waveform = video ? undefined : assetWaveformUrl(asset);
	const { positions, activate } = playback;
	const positionKey = JSON.stringify([playback.boardId, nodeId, src]);
	const mediaRef = useRef<HTMLMediaElement>(null);
	const bindMedia = useCallback((element: HTMLMediaElement | null) => { mediaRef.current = element; }, []);
	const resumeTime = useRef(positions.get(positionKey) ?? 0);
	const hasPosterSize = useRef(false);
	const [clock, setClock] = useState(() => ({ time: resumeTime.current, duration: 0, paused: true, volume: 1, muted: false }));
	const [hasFrame, setHasFrame] = useState(false);
	const [failed, setFailed] = useState(false);
	const [waveformPeaks, setWaveformPeaks] = useState<number[]>([]);
	const waveformReady = waveformPeaks.length > 0;

	useLayoutEffect(() => {
		const media = mediaRef.current;
		if (!media) return;
		return () => {
			if (media.readyState >= 1) {
				if (media.ended || media.currentTime === 0) positions.delete(positionKey);
				else positions.set(positionKey, media.currentTime);
			}
			if (!media.paused) media.pause();
		};
	}, [positions, positionKey]);

	function sync(media: HTMLMediaElement): void {
		setClock({
			time: media.currentTime,
			duration: Number.isFinite(media.duration) ? media.duration : 0,
			paused: media.paused || media.ended,
			volume: media.volume,
			muted: media.muted,
		});
	}

	function syncEvent(event: SyntheticEvent<HTMLMediaElement>): void {
		sync(event.currentTarget);
	}

	function togglePlayback(): void {
		const media = mediaRef.current;
		if (!media) return;
		if (!media.paused && !media.ended) {
			media.pause();
			return;
		}
		activate(media);
		if (failed) {
			setFailed(false);
			media.load();
		}
		void media.play().catch((error: DOMException) => {
			if (error.name !== "AbortError" && media.isConnected) setFailed(true);
		});
	}

	const mediaProps = {
		ref: bindMedia,
		src,
		preload: waveformReady ? "metadata" : "none",
		onLoadedMetadata: ({ currentTarget }: SyntheticEvent<HTMLMediaElement>) => {
			if (resumeTime.current > 0) {
				currentTarget.currentTime = Math.min(resumeTime.current, currentTarget.duration || resumeTime.current);
				resumeTime.current = 0;
			}
			if (currentTarget instanceof HTMLVideoElement && !hasPosterSize.current) onSize(currentTarget.videoWidth, currentTarget.videoHeight);
			sync(currentTarget);
		},
		onPlaying: ({ currentTarget }: SyntheticEvent<HTMLMediaElement>) => {
			if (video) setHasFrame(true);
			sync(currentTarget);
		},
		onTimeUpdate: syncEvent,
		onDurationChange: syncEvent,
		onPlay: syncEvent,
		onPause: syncEvent,
		onEnded: syncEvent,
		onVolumeChange: syncEvent,
		onError: ({ currentTarget }: SyntheticEvent<HTMLMediaElement>) => {
			setFailed(true);
			setHasFrame(false);
			sync(currentTarget);
		},
	};
	const playLabel = clock.paused ? t.preview.play : t.preview.pause;
	const muted = clock.muted || clock.volume === 0;
	const muteLabel = muted ? t.preview.unmute : t.preview.mute;
	const seekTime = Math.min(clock.time, clock.duration);
	const progress = clock.duration > 0 ? 100 * seekTime / clock.duration : 0;
	const playedBars = Math.round(waveformPeaks.length * progress / 100);
	const playButton = (
		<button type="button" className="canvas-player-toggle" aria-label={`${playLabel} ${asset.filename}`}
			disabled={disabled} onClick={(event) => { if (event.detail <= 1) togglePlayback(); }}>
			<PlaybackIcon paused={clock.paused} discDiameter={video ? 29 : 18.5} />
		</button>
	);
	const timeline = (
		<div className={`canvas-player-timeline${waveformReady ? " has-waveform" : ""}`}
			style={{ "--canvas-level": `${progress}%` } as CSSProperties}>
			{waveform && <img className="canvas-waveform-source" crossOrigin="anonymous" src={waveform} alt="" loading="lazy"
				onLoad={(event) => setWaveformPeaks(readWaveformPeaks(event.currentTarget))} />}
			{waveformReady && <span className="canvas-waveform" aria-hidden="true">
				{waveformPeaks.map((peak, index) => (
					<span key={index} className={index < playedBars ? "is-played" : undefined} style={{ height: `${100 * peak}%` }} />
				))}
			</span>}
			<input type="range" className="canvas-player-seek" min={0} max={clock.duration}
				step={Math.min(clock.duration || 1, 0.05)} value={seekTime}
				aria-label={t.preview.seek} aria-valuetext={formatClock(clock.time)} disabled={disabled || clock.duration <= 0}
				onChange={(event) => { if (mediaRef.current) mediaRef.current.currentTime = Number(event.target.value); }} />
		</div>
	);
	return (
		<div className={`canvas-player ${video ? "canvas-video-player" : "canvas-audio-player"}${clock.paused ? "" : " is-playing"}`}>
			{video ? (
				<>
					<AssetThumbnail asset={asset} variant="poster" onMediaLoad={(width, height) => {
						hasPosterSize.current = width > 0 && height > 0;
						onSize(width, height);
					}} />
					<video {...mediaProps} playsInline className={hasFrame ? "has-frame" : undefined} />
					{playButton}
				</>
			) : (
				<>
					<audio {...mediaProps} />
					{timeline}
				</>
			)}
			<div className="canvas-player-controls">
				{video ? timeline : playButton}
				<span className="canvas-player-time">
					<span className="canvas-player-elapsed">{formatClock(clock.time)} / </span>
					{clock.duration > 0 ? formatClock(clock.duration) : "–:––"}
				</span>
				<button type="button" aria-label={muteLabel} data-tooltip={muteLabel} disabled={disabled} onClick={() => {
					const media = mediaRef.current;
					if (!media) return;
					if (media.volume === 0) media.volume = 1;
					media.muted = !muted;
				}}>{muted ? <MutedIcon /> : <VolumeIcon />}</button>
				<input type="range" className="canvas-player-volume" min={0} max={1} step={0.05}
					style={{ "--canvas-level": `${muted ? 0 : 100 * clock.volume}%` } as CSSProperties}
					value={muted ? 0 : clock.volume} aria-label={t.preview.volume} disabled={disabled}
					onChange={(event) => {
						const media = mediaRef.current;
						if (!media) return;
						media.volume = Number(event.target.value);
						media.muted = media.volume === 0;
					}} />
			</div>
			{failed && <p className="canvas-player-error" role="status">{t.preview.electronFailed}</p>}
		</div>
	);
}
