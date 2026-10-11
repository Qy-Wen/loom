export type MediaSize = {
	width: number;
	height: number;
};

export type MediaView = {
	scale: number;
	x: number;
	y: number;
};

export const MIN_MEDIA_SCALE = 0.25;
export const MAX_MEDIA_SCALE = 16;
/** Fitted zoom cannot exceed this, so a very wide pane cannot request a huge transform. */
export const MEDIA_ZOOM_CAP = 32;
export const MEDIA_ZOOM_STEP = 1.25;

export const FIT_MEDIA_VIEW: MediaView = { scale: 1, x: 0, y: 0 };

export function hasMediaSize(size: MediaSize): boolean {
	return size.width > 0 && size.height > 0 && Number.isFinite(size.width) && Number.isFinite(size.height);
}

/** Largest size that fits in the viewport without enlarging a picture that is already smaller. */
export function fittedMediaSize(natural: MediaSize, viewport: MediaSize): MediaSize {
	if (!hasMediaSize(natural) || !hasMediaSize(viewport)) return { width: 0, height: 0 };
	const scale = Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
	return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
}

/** Far enough to reach native pixels, and at least {@link MAX_MEDIA_SCALE} for smaller files. */
export function maxMediaScale(natural: MediaSize, fitted: MediaSize): number {
	if (!hasMediaSize(natural) || !hasMediaSize(fitted)) return MAX_MEDIA_SCALE;
	const native = Math.max(natural.width / fitted.width, natural.height / fitted.height);
	return Math.min(MEDIA_ZOOM_CAP, Math.max(MAX_MEDIA_SCALE, native));
}

export function clampMediaScale(scale: number, maxScale = MAX_MEDIA_SCALE): number {
	if (!Number.isFinite(scale)) return 1;
	return Math.min(maxScale, Math.max(MIN_MEDIA_SCALE, scale));
}

function tidy(value: number): number {
	return Math.abs(value) < 0.01 ? 0 : value;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(max, Math.max(min, value));
}

/** Pan only into the part of the picture that sticks out of the frame. */
export function clampMediaPan(view: MediaView, viewport: MediaSize, media: MediaSize): MediaView {
	if (!hasMediaSize(viewport) || !hasMediaSize(media)) return { scale: view.scale, x: 0, y: 0 };
	const limitX = Math.max(0, media.width * view.scale - viewport.width) / 2;
	const limitY = Math.max(0, media.height * view.scale - viewport.height) / 2;
	return {
		scale: view.scale,
		x: tidy(clamp(view.x, -limitX, limitX)),
		y: tidy(clamp(view.y, -limitY, limitY)),
	};
}

export function clampMediaView(
	view: MediaView,
	viewport: MediaSize,
	media: MediaSize,
	maxScale = MAX_MEDIA_SCALE,
): MediaView {
	return clampMediaPan({ ...view, scale: clampMediaScale(view.scale, maxScale) }, viewport, media);
}

/**
 * Zoom toward a cursor given in viewport-center coordinates.
 * The media point under the cursor stays put when the frame has room.
 */
export function zoomMediaAt(
	view: MediaView,
	cursor: { x: number; y: number },
	factor: number,
	viewport: MediaSize,
	media: MediaSize,
	maxScale = MAX_MEDIA_SCALE,
): MediaView {
	if (!hasMediaSize(viewport) || !hasMediaSize(media) || !Number.isFinite(factor) || factor <= 0 || view.scale <= 0) {
		return view;
	}
	const scale = clampMediaScale(view.scale * factor, maxScale);
	const x = cursor.x - ((cursor.x - view.x) * scale) / view.scale;
	const y = cursor.y - ((cursor.y - view.y) * scale) / view.scale;
	return clampMediaPan({ scale, x, y }, viewport, media);
}

export function panMedia(
	view: MediaView,
	delta: { x: number; y: number },
	viewport: MediaSize,
	media: MediaSize,
): MediaView {
	if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return view;
	return clampMediaPan({ ...view, x: view.x + delta.x, y: view.y + delta.y }, viewport, media);
}

export function isFittedMedia(view: MediaView): boolean {
	return Math.abs(view.scale - 1) < 0.02 && Math.abs(view.x) < 0.5 && Math.abs(view.y) < 0.5;
}

/** Double-click zooms to 2× at the cursor, or returns to the fitted view. */
export function toggleMediaZoom(
	view: MediaView,
	cursor: { x: number; y: number },
	viewport: MediaSize,
	media: MediaSize,
	maxScale = MAX_MEDIA_SCALE,
): MediaView {
	if (!isFittedMedia(view)) return { ...FIT_MEDIA_VIEW };
	return zoomMediaAt(view, cursor, 2, viewport, media, maxScale);
}

/** Wheel up (negative deltaY) zooms in. Line and page deltas are converted to pixels. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
	if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
	const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY;
	const delta = Math.max(-400, Math.min(400, pixels));
	return Math.exp(-delta / 650);
}

/** Pan in screen pixels, then scale around the center of the fitted frame. */
export function mediaLayerTransform(view: MediaView): string {
	const x = Number.isFinite(view.x) ? view.x : 0;
	const y = Number.isFinite(view.y) ? view.y : 0;
	const scale = Number.isFinite(view.scale) ? view.scale : 1;
	return `translate(${x}px, ${y}px) scale(${scale})`;
}

export function cursorFromViewport(
	viewport: { left: number; top: number; width: number; height: number },
	clientX: number,
	clientY: number,
): { x: number; y: number } {
	return {
		x: clientX - viewport.left - viewport.width / 2,
		y: clientY - viewport.top - viewport.height / 2,
	};
}
